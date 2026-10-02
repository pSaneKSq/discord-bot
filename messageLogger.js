const { AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const db = require('./db.js');
const moderationStore = require('./moderationStore.js');

// Логи правок и удалений сообщений.
// Тексты сообщений кэшируются ТОЛЬКО В ПАМЯТИ (последние CACHE_LIMIT штук) — чтобы при правке
// или удалении показать «было». После перезапуска бота кэш пуст: для старых сообщений текст недоступен.
const CACHE_LIMIT = 10000;
const CONTENT_LIMIT = 1900;
const LOG_TEXT_LIMIT = 1000;
// Личные переписки (тикеты и собеседования) в журнал не попадают
const IGNORED_CHANNEL_PREFIXES = ['ticket-', 'собеседование-'];

const contentCache = new Map();      // messageId -> { content, authorId, channelId, attachments }
const suppressedDeletes = new Map(); // messageId -> timestamp (удаления, которые логировать не нужно)

// Вызывается автомодерацией перед удалением сообщения — чтобы оно не попало в журнал удалений
function suppressDeleteLog(messageId) {
    suppressedDeletes.set(messageId, Date.now());
}

// Настройки читаются с диска, поэтому кэшируем на 10 секунд (иначе файл читался бы на каждое сообщение)
const configCache = new Map(); // guildId -> { config, cachedAt }

function getConfig(guildId) {
    const now = Date.now();
    const cached = configCache.get(guildId);
    if (cached && now - cached.cachedAt < 10000) {
        return cached.config;
    }

    const settings = moderationStore.getSettings(guildId);
    const config = {
        enabled: settings.messageLog.enabled,
        retentionDays: settings.messageLog.retentionDays,
        logChannelId: settings.logChannelId
    };
    configCache.set(guildId, { config, cachedAt: now });
    return config;
}

function trunc(text, limit) {
    const s = String(text || '');
    return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}

function isIgnoredChannel(guild, channelId, config) {
    if (config.logChannelId && channelId === config.logChannelId) return true;
    const name = (guild.channels.cache.get(channelId)?.name || '').toLowerCase();
    return IGNORED_CHANNEL_PREFIXES.some(prefix => name.startsWith(prefix));
}

function isTrackableGuild(guild) {
    if (!guild) return false;
    return !process.env.GUILD_ID || guild.id === process.env.GUILD_ID;
}

function remember(message) {
    contentCache.set(message.id, {
        content: trunc(message.content, CONTENT_LIMIT),
        authorId: message.author.id,
        channelId: message.channelId,
        attachments: [...message.attachments.values()].map(a => a.name).slice(0, 10)
    });
    if (contentCache.size > CACHE_LIMIT) {
        contentCache.delete(contentCache.keys().next().value);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Кто удалил — по журналу аудита (получится только если удалил модератор, а не сам автор)
async function findDeleter(guild, authorId, channelId) {
    try {
        const me = guild.members.me;
        if (!me || !me.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;

        await sleep(1000); // запись в журнале аудита появляется с небольшой задержкой
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 });
        const now = Date.now();
        const entry = logs.entries.find(e =>
            e.target && e.target.id === authorId &&
            e.extra && e.extra.channel && e.extra.channel.id === channelId &&
            now - e.createdTimestamp < 6000
        );
        return entry ? entry.executor : null;
    } catch (err) {
        return null;
    }
}

function register(client, sendLog) {

    // Запоминаем текст новых сообщений
    client.on('messageCreate', (message) => {
        try {
            if (!message.guild) return;
            const config = getConfig(message.guild.id);
            if (!config.enabled) return;
            if (!isTrackableGuild(message.guild)) return;
            if (message.author.bot) return;
            if (isIgnoredChannel(message.guild, message.channelId, config)) return;
            remember(message);
        } catch (err) {
            console.error('[MessageLog] Ошибка кэширования сообщения:', err.message);
        }
    });

    // ПРАВКА СООБЩЕНИЯ
    client.on('messageUpdate', async (oldMessage, newMessage) => {
        try {
            if (newMessage.partial) {
                try { newMessage = await newMessage.fetch(); } catch (err) { return; }
            }
            if (!newMessage.guild) return;
            const config = getConfig(newMessage.guild.id);
            if (!config.enabled) return;

            if (!isTrackableGuild(newMessage.guild)) return;
            if (!newMessage.author || newMessage.author.bot) return;
            if (isIgnoredChannel(newMessage.guild, newMessage.channelId, config)) return;

            const cached = contentCache.get(newMessage.id);
            const oldContent = cached
                ? cached.content
                : (oldMessage && !oldMessage.partial ? oldMessage.content : null);
            const newContent = newMessage.content || '';

            if (oldContent !== null && oldContent === newContent) return; // например, подгрузился предпросмотр ссылки

            // Старого текста нет — принимаем только свежие настоящие правки
            if (oldContent === null) {
                const editedAt = newMessage.editedTimestamp;
                if (!editedAt || Date.now() - editedAt > 15000) return;
            }

            remember(newMessage);

            const oldText = oldContent === null
                ? '(текст недоступен — сообщение отправлено до запуска бота)'
                : trunc(oldContent || '(пусто)', LOG_TEXT_LIMIT);

            await sendLog(
                newMessage.guild,
                '✏️ **ПРАВКА СООБЩЕНИЯ**\n' +
                `👤 **Автор:** <@${newMessage.author.id}>\n` +
                `📍 **Канал:** <#${newMessage.channelId}>\n` +
                `🔗 ${newMessage.url}\n` +
                `**Было:**\n${oldText}\n` +
                `**Стало:**\n${trunc(newContent || '(пусто)', LOG_TEXT_LIMIT)}`,
                'message_edit'
            );
        } catch (err) {
            console.error('[MessageLog] Ошибка логирования правки:', err.message);
        }
    });

    // УДАЛЕНИЕ СООБЩЕНИЯ
    client.on('messageDelete', async (message) => {
        try {
            const config = getConfig();
            if (!config.enabled) return;
            if (!message.guild || !isTrackableGuild(message.guild)) return;

            // Удаление, которое сделала автомодерация — в журнал удалений не пишем
            if (suppressedDeletes.has(message.id)) {
                suppressedDeletes.delete(message.id);
                contentCache.delete(message.id);
                return;
            }

            const cached = contentCache.get(message.id);
            contentCache.delete(message.id);

            const authorId = (cached && cached.authorId) || (message.author && message.author.id) || null;
            const content = cached ? cached.content : (message.partial ? null : (message.content || ''));

            // Ничего не известно (сообщение старое и не в кэше) — писать в журнал нечего
            if (!authorId && content === null) return;
            if (message.author && message.author.bot) return;
            if (client.user && authorId === client.user.id) return;
            if (isIgnoredChannel(message.guild, message.channelId, config)) return;

            const attachments = cached
                ? cached.attachments
                : (message.attachments ? [...message.attachments.values()].map(a => a.name).slice(0, 10) : []);

            const deleter = authorId ? await findDeleter(message.guild, authorId, message.channelId) : null;

            let text = '🗑️ **УДАЛЕНО СООБЩЕНИЕ**\n' +
                `👤 **Автор:** ${authorId ? `<@${authorId}>` : 'неизвестен'}\n` +
                `📍 **Канал:** <#${message.channelId}>\n`;
            if (deleter) text += `🛠️ **Удалил:** <@${deleter.id}> (по журналу аудита)\n`;
            text += `**Текст:**\n${content === null ? '(текст недоступен — сообщение отправлено до запуска бота)' : trunc(content || '(пусто)', LOG_TEXT_LIMIT)}`;
            if (attachments.length) text += `\n📎 **Вложения:** ${attachments.join(', ')}`;

            await sendLog(message.guild, text, 'message_delete');
        } catch (err) {
            console.error('[MessageLog] Ошибка логирования удаления:', err.message);
        }
    });

    // МАССОВОЕ УДАЛЕНИЕ (например, очистка канала)
    client.on('messageDeleteBulk', async (messages, channel) => {
        try {
            const config = getConfig();
            if (!config.enabled) return;
            if (!channel.guild || !isTrackableGuild(channel.guild)) return;

            messages.forEach((_, id) => contentCache.delete(id));
            if (isIgnoredChannel(channel.guild, channel.id, config)) return;

            await sendLog(
                channel.guild,
                '🧹 **МАССОВОЕ УДАЛЕНИЕ СООБЩЕНИЙ**\n' +
                `📍 **Канал:** <#${channel.id}>\n` +
                `🗑️ **Удалено сообщений:** ${messages.size}`,
                'message_delete'
            );
        } catch (err) {
            console.error('[MessageLog] Ошибка логирования массового удаления:', err.message);
        }
    });

    // Чистим устаревшие записи журнала правок/удалений (срок задаётся в настройках)
    async function cleanupOldLogs() {
        try {
            // Используем дефолтное значение 30 дней, так как очистка глобальная для всех серверов
            const retentionDays = 30;
            await db.query(
                `DELETE FROM mod_logs
                 WHERE event_type IN ('message_edit', 'message_delete')
                   AND created_at < NOW() - make_interval(days => $1::int)`,
                [retentionDays]
            );
        } catch (err) {
            console.error('[MessageLog] Ошибка очистки старых логов:', err.message);
        }
    }
    setTimeout(cleanupOldLogs, 60 * 1000).unref();
    setInterval(cleanupOldLogs, 6 * 60 * 60 * 1000).unref();

    // Чистим список «подавленных» удалений
    setInterval(() => {
        const now = Date.now();
        for (const [id, ts] of suppressedDeletes) {
            if (now - ts > 60 * 1000) suppressedDeletes.delete(id);
        }
    }, 60 * 1000).unref();
}

module.exports = { register, suppressDeleteLog };