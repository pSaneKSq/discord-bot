const automodStore = require('./automodStore.js');
const { suppressDeleteLog } = require('./messageLogger.js');

const INVITE_REGEX = /(discord\.gg\/|discord(?:app)?\.com\/invite\/)[a-zA-Z0-9-]+/i;

// Учёт сообщений для антиспама — не персистентно (как и pendingInterviews в tickets.js),
// это нормально: при перезапуске бота счётчики просто обнулятся.
const recentMessages = new Map();     // "guildId_userId" -> [timestamps]
const spamLogCooldown = new Map();    // "guildId_userId" -> timestamp последнего лога антиспама

// Максимальный срок таймаута в Discord — 28 дней
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

// Ищет банворд как отдельное "слово" (учитывает кириллицу — \b в JS работает только для ASCII)
function findBannedWord(content, words) {
    const lower = content.toLowerCase();
    return words.find(word => {
        if (!word) return false;
        const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|[^a-zа-яё0-9])${escaped}([^a-zа-яё0-9]|$)`, 'i');
        return regex.test(lower);
    });
}

function capsPercent(content) {
    const letters = content.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
    if (!letters.length) return 0;
    const upper = letters.replace(/[^A-ZА-ЯЁ]/g, '');
    return Math.round((upper.length / letters.length) * 100);
}

// Есть ли в тексте фраза как отдельные слова (чтобы «пишется с» не срабатывало на «пишется слово»)
function containsPhrase(lowerText, phrase) {
    const p = String(phrase || '').trim().toLowerCase();
    if (!p) return false;
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-zа-яё0-9])${escaped}([^a-zа-яё0-9]|$)`, 'i');
    return regex.test(lowerText);
}

// «Защита от тупых людей»: определяет, что сообщение — поправка чужой грамматики.
// 1) Строгий режим: одна «*» в начале или в конце сообщения («* Короче» / «короче*») — сразу поправка.
// 2) Обычный режим: в сообщении есть фраза-триггер («пишется через» и т.п.). Звёздочка НЕ обязательна.
// Вопросы (со знаком «?») не трогаем — человек может просто спрашивать, как пишется слово.
function isCorrection(content, cfg) {
    const text = (content || '').trim();
    if (!text || !/[a-zа-яё]/i.test(text)) return false;

    const starCount = (text.match(/\*/g) || []).length;
    const hasAsterisk = starCount === 1 && (/^\*\s*\S/.test(text) || /\S\*$/.test(text));

    if (cfg.strictAsterisk && hasAsterisk) return true;

    if (text.includes('?')) return false;

    const lower = text.toLowerCase();
    return (cfg.triggerPhrases || []).some(phrase => containsPhrase(lower, phrase));
}

// Красивая запись срока: 90 -> "1 ч 30 мин", 60 -> "1 ч", 1440 -> "1 дн."
function formatDuration(minutes) {
    const m = Math.max(1, Math.round(minutes));
    if (m % 1440 === 0) return `${m / 1440} дн.`;
    if (m >= 60) {
        const h = Math.floor(m / 60);
        const rest = m % 60;
        return rest ? `${h} ч ${rest} мин` : `${h} ч`;
    }
    return `${m} мин`;
}

async function deleteAndNotify(message, reasonText) {
    // Помечаем сообщение, чтобы логгер удалений не записал его как обычное удаление
    suppressDeleteLog(message.id);
    try {
        await message.delete();
    } catch (err) {
        // сообщение уже могло быть удалено кем-то ещё — не критично
    }
    try {
        const notice = await message.channel.send(`⚠️ <@${message.author.id}>, ${reasonText}`);
        setTimeout(() => notice.delete().catch(() => {}), 5000);
    } catch (err) {
        // канал мог стать недоступен — не критично
    }
}

// Применяет наказание за «поправку»: (опционально) удаляет сообщение, мутит, шлёт ЛС, пишет в журнал
async function applyPedantry(message, cfg, sendLog) {
    const member = message.member;
    const minutes = cfg.muteMinutes;
    const durationText = formatDuration(minutes);
    const channelMention = `<#${message.channel.id}>`;

    if (cfg.deleteMessage) {
        suppressDeleteLog(message.id);
        await message.delete().catch(() => {});
    }

    // Уже в муте — повторно не наказываем и не пишем в ЛС
    if (member && member.isCommunicationDisabled()) return;

    let muted = false;
    let muteError = '';

    if (!member) {
        muteError = 'участник не найден на сервере';
    } else if (!member.moderatable) {
        muteError = 'у бота нет права Moderate Members, либо роль участника выше роли бота (или это владелец/админ)';
    } else {
        try {
            await member.timeout(
                Math.min(minutes * 60 * 1000, MAX_TIMEOUT_MS),
                'Защита от тупых людей: поправки других участников'
            );
            muted = true;
        } catch (err) {
            muteError = `ошибка Discord: ${err.message}`;
            console.error('❌ Защита от тупых людей: не удалось выдать мут:', err.message);
        }
    }

    if (!muted) {
        await sendLog(message.guild, `⚠️ Защита от тупых людей: сообщение <@${message.author.id}> в ${channelMention} признано поправкой, но **мут не применён** — ${muteError}.`, 'automod');
        return;
    }

    let dmStatus = 'отключена в настройках';
    if (cfg.sendDm) {
        const dmText = String(cfg.dmText || '')
            .replace(/\{duration\}/g, durationText)
            .replace(/\{server\}/g, message.guild.name);
        try {
            await message.author.send(dmText);
            dmStatus = 'доставлено';
        } catch (err) {
            dmStatus = 'не доставлено (закрыты ЛС)';
        }
    }

    // Короткая цитата для журнала (без символов, которые могут дать пинг или сломать разметку)
    const excerpt = (message.content || '').replace(/[<>@`*\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    const deletedNote = cfg.deleteMessage ? ' Сообщение удалено.' : '';

    await sendLog(
        message.guild,
        `🤓 Защита от тупых людей: <@${message.author.id}> получил мут на **${durationText}** за поправку других в ${channelMention}. ЛС: ${dmStatus}.${deletedNote}${excerpt ? ` Сообщение: «${excerpt}»` : ''}`,
        'automod'
    );
}

module.exports = function(client, sendLog) {
    client.on('messageCreate', async (message) => {
        if (message.author.bot || !message.guild) return;

        const settings = automodStore.getSettings(message.guild.id);
        if (!settings.enabled) return;

        // Пользователи с "защищёнными" ролями не проверяются автомодерацией
        if (settings.exemptRoleIds.length && message.member) {
            const isExempt = message.member.roles.cache.some(r => settings.exemptRoleIds.includes(r.id));
            if (isExempt) return;
        }

        const content = message.content || '';

        // 1. Банворды
        if (settings.bannedWords.enabled && settings.bannedWords.words.length) {
            const matched = findBannedWord(content, settings.bannedWords.words);
            if (matched) {
                await deleteAndNotify(message, 'сообщение удалено — содержит запрещённое слово.');
                await sendLog(message.guild, `🚫 Автомодерация удалила сообщение от <@${message.author.id}> в <#${message.channel.id}> за запрещённое слово.`, 'automod');
                return;
            }
        }

        // 2. Инвайты на другие серверы
        if (settings.invites.enabled && INVITE_REGEX.test(content)) {
            await deleteAndNotify(message, 'сообщение удалено — приглашения на другие серверы запрещены.');
            await sendLog(message.guild, `🚫 Автомодерация удалила сообщение от <@${message.author.id}> в <#${message.channel.id}> за ссылку-приглашение.`, 'automod');
            return;
        }

        // 3. Mention-спам
        const mentionCount = message.mentions.users.size + message.mentions.roles.size;
        if (settings.mentionSpam.enabled && mentionCount > settings.mentionSpam.maxMentions) {
            await deleteAndNotify(message, `сообщение удалено — слишком много упоминаний (${mentionCount}).`);
            await sendLog(message.guild, `🚫 Автомодерация удалила сообщение от <@${message.author.id}> в <#${message.channel.id}> за спам упоминаниями (${mentionCount}).`, 'automod');
            return;
        }

        // 4. Капс
        if (settings.caps.enabled && content.length >= settings.caps.minLength) {
            const percent = capsPercent(content);
            if (percent >= settings.caps.maxPercent) {
                await deleteAndNotify(message, 'сообщение удалено — слишком много заглавных букв.');
                await sendLog(message.guild, `🚫 Автомодерация удалила сообщение от <@${message.author.id}> в <#${message.channel.id}> за капс (${percent}%).`, 'automod');
                return;
            }
        }

        // 5. Антиспам (лимит сообщений за N секунд)
        if (settings.spam.enabled) {
            const now = Date.now();
            const windowMs = settings.spam.perSeconds * 1000;
            const key = `${message.guild.id}_${message.author.id}`;
            const timestamps = (recentMessages.get(key) || []).filter(t => now - t < windowMs);
            timestamps.push(now);
            recentMessages.set(key, timestamps);

            if (timestamps.length > settings.spam.maxMessages) {
                await deleteAndNotify(message, `сообщение удалено — превышен лимит сообщений (${settings.spam.maxMessages} за ${settings.spam.perSeconds} сек).`);

                // Логируем не каждое лишнее сообщение подряд, а раз в 10 секунд на пользователя
                const lastLog = spamLogCooldown.get(key) || 0;
                if (now - lastLog > 10000) {
                    spamLogCooldown.set(key, now);
                    await sendLog(message.guild, `🚫 Автомодерация: <@${message.author.id}> превысил лимит сообщений в <#${message.channel.id}> (антиспам).`, 'automod');
                }
                return; // сообщение уже удалено антиспамом — дальше не проверяем
            }
        }

        // 6. Защита от тупых людей (мут за поправки других)
        if (settings.pedantry && settings.pedantry.enabled && isCorrection(content, settings.pedantry)) {
            try {
                await applyPedantry(message, settings.pedantry, sendLog);
            } catch (err) {
                console.error('❌ Ошибка в модуле «Защита от тупых людей»:', err);
            }
        }
    });
};