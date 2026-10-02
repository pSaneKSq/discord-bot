const { EmbedBuilder } = require('discord.js');
const db = require('./db.js');
const analyticsStore = require('./analyticsStore.js');
const store = require('./weeklyReportStore.js');

const PERIOD_DAYS = 7;
const CHECK_INTERVAL_MS = 30 * 1000;
const GRACE_MS = 15 * 60 * 1000;   // окно после назначенного времени, в котором отчёт ещё можно отправить

let logFn = null;   // sendLog из logger.js
let tickRunning = false;

// ---------- Часовые пояса (без внешних библиотек) ----------

function tzParts(ms, timeZone) {
    const f = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p = {};
    f.formatToParts(new Date(ms)).forEach(part => { if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10); });
    return p;
}

function tzOffsetMs(ms, timeZone) {
    const p = tzParts(ms, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
}

// Локальное время в поясе → момент в UTC (с поправкой на переход летнего времени)
function zonedToUtc(y, m, d, h, mi, timeZone) {
    const guess = Date.UTC(y, m - 1, d, h, mi, 0);
    const off = tzOffsetMs(guess, timeZone);
    let result = guess - off;
    const off2 = tzOffsetMs(result, timeZone);
    if (off2 !== off) result = guess - off2;
    return result;
}

// Ближайший назначенный момент в прошлом (или сейчас)
function lastOccurrence(now, dayOfWeek, time, timeZone) {
    const [h, mi] = time.split(':').map(Number);
    const t = tzParts(now, timeZone);
    for (let back = 0; back <= 7; back++) {
        const d = new Date(Date.UTC(t.year, t.month - 1, t.day - back));
        if (d.getUTCDay() !== dayOfWeek) continue;
        const occ = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi, timeZone);
        if (occ <= now) return occ;
    }
    return null;
}

// Ближайший назначенный момент в будущем
function nextOccurrence(now, dayOfWeek, time, timeZone) {
    const [h, mi] = time.split(':').map(Number);
    const t = tzParts(now, timeZone);
    for (let ahead = 0; ahead <= 8; ahead++) {
        const d = new Date(Date.UTC(t.year, t.month - 1, t.day + ahead));
        if (d.getUTCDay() !== dayOfWeek) continue;
        const occ = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi, timeZone);
        if (occ > now) return occ;
    }
    return null;
}

function formatDate(ms, timeZone) {
    return new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ms));
}

function formatDateTime(ms, timeZone) {
    return new Intl.DateTimeFormat('ru-RU', {
        timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(ms));
}

// ---------- Сбор данных ----------

function pctChange(curr, prev) {
    if (prev === 0) return curr > 0 ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 100);
}

async function countPeriod(sql, params) {
    const res = await db.query(sql, params);
    return res.rows[0].count;
}

// Заявки и предупреждения за окно [now - startDays, now - endDays)
async function extraPeriodStats(guildId, startDays, endDays) {
    const [submitted, accepted, rejected, warns] = await Promise.all([
        countPeriod(`SELECT COUNT(*)::int AS count FROM form_applications
                     WHERE created_at >= NOW() - make_interval(days => $1::int) AND created_at < NOW() - make_interval(days => $2::int)`, [startDays, endDays]),
        countPeriod(`SELECT COUNT(*)::int AS count FROM form_applications
                     WHERE status = 'accepted' AND decided_at >= NOW() - make_interval(days => $1::int) AND decided_at < NOW() - make_interval(days => $2::int)`, [startDays, endDays]),
        countPeriod(`SELECT COUNT(*)::int AS count FROM form_applications
                     WHERE status = 'rejected' AND decided_at >= NOW() - make_interval(days => $1::int) AND decided_at < NOW() - make_interval(days => $2::int)`, [startDays, endDays]),
        countPeriod(`SELECT COUNT(*)::int AS count FROM warnings
                     WHERE guild_id = $3 AND created_at >= NOW() - make_interval(days => $1::int) AND created_at < NOW() - make_interval(days => $2::int)`, [startDays, endDays, guildId])
    ]);
    return { submitted, accepted, rejected, warns };
}

async function collectData(guild, settings) {
    const guildId = guild.id;
    const limit = settings.topLimit;
    const s = settings.sections;

    const overview = await analyticsStore.getOverview(guildId, PERIOD_DAYS);

    const [curExtra, prevExtra, pendingRes] = await Promise.all([
        extraPeriodStats(guildId, PERIOD_DAYS, 0),
        extraPeriodStats(guildId, PERIOD_DAYS * 2, PERIOD_DAYS),
        db.query(`SELECT COUNT(*)::int AS count FROM form_applications WHERE status = 'pending'`)
    ]);

    const data = {
        totalMembers: guild.memberCount,
        overview,
        applications: { ...curExtra, pending: pendingRes.rows[0].count },
        warnsTrend: pctChange(curExtra.warns, prevExtra.warns),
        appsTrend: pctChange(curExtra.submitted, prevExtra.submitted),
        activeChannel: null,
        topMessages: [], topVoice: [], allTimeMessages: [], allTimeVoice: [], levels: [],
        swears: null
    };

    // Статистика матов
    if (s.swears) {
        const swearStats = await analyticsStore.getSwearStats(guildId, PERIOD_DAYS);
        data.swears = swearStats;
    }

    if (s.activeChannel) {
        const rows = await analyticsStore.getTopChannels(guildId, PERIOD_DAYS, 'messages', 1);
        if (rows.length) data.activeChannel = { channelId: rows[0].channel_id, value: rows[0].value };
    }
    if (s.topMessages) {
        const rows = await analyticsStore.getTopMembers(guildId, PERIOD_DAYS, 'messages', limit);
        data.topMessages = rows.map(r => ({ userId: r.user_id, value: Number(r.value) }));
    }
    if (s.topVoice) {
        const rows = await analyticsStore.getTopMembers(guildId, PERIOD_DAYS, 'voice', limit);
        data.topVoice = rows.map(r => ({ userId: r.user_id, value: Number(r.value) }));
    }
    if (s.allTimeMessages) {
        const res = await db.query(
            `SELECT user_id, messages_count AS value FROM activity_totals
             WHERE guild_id = $1 AND messages_count > 0 ORDER BY messages_count DESC LIMIT $2`, [guildId, limit]);
        data.allTimeMessages = res.rows.map(r => ({ userId: r.user_id, value: Number(r.value) }));
    }
    if (s.allTimeVoice) {
        const res = await db.query(
            `SELECT user_id, ROUND(voice_seconds / 3600.0, 2) AS value FROM activity_totals
             WHERE guild_id = $1 AND voice_seconds > 0 ORDER BY voice_seconds DESC LIMIT $2`, [guildId, limit]);
        data.allTimeVoice = res.rows.map(r => ({ userId: r.user_id, value: Number(r.value) }));
    }
    if (s.levels) {
        const res = await db.query(
            `SELECT user_id, xp, level FROM user_levels
             WHERE guild_id = $1 AND xp > 0 ORDER BY xp DESC LIMIT $2`, [guildId, limit]);
        data.levels = res.rows.map(r => ({ userId: r.user_id, xp: Number(r.xp), level: Number(r.level) }));
    }

    return data;
}

// ---------- Сборка сообщения ----------

const MEDALS = ['🥇', '🥈', '🥉'];

function trendText(value) {
    if (value > 0) return `▲ ${value}%`;
    if (value < 0) return `▼ ${Math.abs(value)}%`;
    return '—';
}

function fmtNum(n) {
    return new Intl.NumberFormat('ru-RU').format(n);
}

function fmtHours(h) {
    return `${fmtNum(Math.round(h * 10) / 10)} ч`;
}

function applyPlaceholders(text, ctx) {
    return String(text || '')
        .replace(/\{server\}/g, ctx.server)
        .replace(/\{from\}/g, ctx.from)
        .replace(/\{to\}/g, ctx.to);
}

// mode: 'discord' — настоящие упоминания (<@id>), 'plain' — имена (для предпросмотра на сайте)
async function buildMessage(guild, settings, mode = 'discord') {
    const data = await collectData(guild, settings);
    const s = settings.sections;
    const tz = settings.timezone;
    const now = Date.now();

    const ctx = {
        server: guild.name,
        from: formatDate(now - PERIOD_DAYS * 86400000, tz),
        to: formatDate(now, tz)
    };

    // Имена для предпросмотра
    const names = {};
    if (mode === 'plain') {
        const ids = new Set();
        [data.topMessages, data.topVoice, data.allTimeMessages, data.allTimeVoice, data.levels].forEach(list => list.forEach(i => ids.add(i.userId)));
        await Promise.all([...ids].map(async (id) => {
            const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
            names[id] = member ? member.displayName : id;
        }));
    }
    const who = (id) => mode === 'plain' ? `@${names[id] || id}` : `<@${id}>`;
    const chan = (id) => {
        if (mode !== 'plain') return `<#${id}>`;
        const c = guild.channels.cache.get(id);
        return `#${c ? c.name : 'канал'}`;
    };

    const cmp = (value) => s.comparison ? ` (${trendText(value)})` : '';
    const ov = data.overview;

    const embed = new EmbedBuilder().setColor(settings.embed.color);
    const title = applyPlaceholders(settings.embed.title, ctx).slice(0, 256);
    const description = applyPlaceholders(settings.embed.description, ctx).slice(0, 4000);
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);

    const fields = [];

    if (s.members) {
        const net = ov.joins - ov.leaves;
        fields.push({
            name: '👥 Участники',
            value: `Пришло: **+${ov.joins}**${cmp(ov.trends.joins)}\n` +
                   `Ушло: **-${ov.leaves}**${cmp(ov.trends.leaves)}\n` +
                   `Итого: **${net > 0 ? '+' : ''}${net}**\n` +
                   `Сейчас на сервере: **${fmtNum(data.totalMembers)}**`,
            inline: true
        });
    }

    if (s.applications) {
        const a = data.applications;
        fields.push({
            name: '📝 Заявки',
            value: `Подано: **${a.submitted}**${cmp(data.appsTrend)}\n` +
                   `Принято: **${a.accepted}**\n` +
                   `Отклонено: **${a.rejected}**\n` +
                   `Ждут решения: **${a.pending}**`,
            inline: true
        });
    }

    if (s.warnings) {
        fields.push({
            name: '⚠️ Предупреждения',
            value: `Выдано за неделю: **${data.applications.warns}**${cmp(data.warnsTrend)}`,
            inline: true
        });
    }

    if (s.swears && data.swears) {
        let swearValue = `За неделю: **${data.swears.total}**${cmp(data.swears.trend)}`;

        // Добавляем информацию о топовом матерящемся
        if (data.swears.topSwearers && data.swears.topSwearers.length > 0) {
            const topSwearer = data.swears.topSwearers[0];
            swearValue += `\nГлавный матершиник: ${who(topSwearer.user_id)} (${topSwearer.count})`;
        }

        // Добавляем самое частое слово
        if (data.swears.mostFrequentWord) {
            swearValue += `\nСамое частое слово: **${data.swears.mostFrequentWord.word}** (${data.swears.mostFrequentWord.count})`;
        }

        fields.push({
            name: '🤬 Маты',
            value: swearValue,
            inline: true
        });
    }

    if (s.activity) {
        fields.push({
            name: '💬 Активность',
            value: `Сообщений: **${fmtNum(ov.totalMessages)}**${cmp(ov.trends.messages)}\n` +
                   `В войсе: **${fmtHours(ov.totalVoiceHours)}**${cmp(ov.trends.voiceHours)}\n` +
                   `Активных участников: **${ov.activeMembers}**${cmp(ov.trends.active)}`,
            inline: true
        });
    }

    if (s.activeChannel) {
        fields.push({
            name: '🔥 Самый активный канал',
            value: data.activeChannel
                ? `${chan(data.activeChannel.channelId)}\n**${fmtNum(data.activeChannel.value)}** сообщ.`
                : 'Нет данных',
            inline: true
        });
    }

    const topList = (list, unit) => {
        if (!list.length) return 'Нет данных';
        return list.map((item, i) => `${MEDALS[i] || `**${i + 1}.**`} ${who(item.userId)} — **${fmtNum(item.value)}** ${unit}`).join('\n').slice(0, 1024);
    };

    if (s.topMessages) fields.push({ name: '🏆 Топ по сообщениям — неделя', value: topList(data.topMessages, 'сообщ.'), inline: true });
    if (s.topVoice) fields.push({ name: '🎙️ Топ по войсу — неделя', value: topList(data.topVoice, 'ч'), inline: true });
    if (s.allTimeMessages) fields.push({ name: '⭐ Топ по сообщениям — всё время', value: topList(data.allTimeMessages, 'сообщ.'), inline: true });
    if (s.allTimeVoice) fields.push({ name: '🎧 Топ по войсу — всё время', value: topList(data.allTimeVoice, 'ч'), inline: true });
    if (s.levels) {
        const levelsList = () => {
            if (!data.levels.length) return 'Нет данных';
            return data.levels.map((item, i) => `${MEDALS[i] || `**${i + 1}.**`} ${who(item.userId)} — **Уровень ${item.level}** (${item.xp.toLocaleString()} XP)`).join('\n').slice(0, 1024);
        };
        fields.push({ name: '🎖️ Топ по уровням', value: levelsList(), inline: true });
    }

    if (fields.length) embed.addFields(fields);

    if (settings.embed.footer) embed.setFooter({ text: applyPlaceholders(settings.embed.footer, ctx).slice(0, 2000) });
    if (settings.embed.timestamp) embed.setTimestamp();
    if (settings.embed.imageUrl) embed.setImage(settings.embed.imageUrl);
    if (settings.embed.thumbnail) {
        const icon = guild.iconURL({ size: 128 });
        if (icon) embed.setThumbnail(icon);
    }

    // Текст над эмбедом: пинг + свой текст
    const parts = [];
    let allowedMentions = { parse: [] };
    if (settings.pingRole === 'everyone') {
        parts.push('@everyone');
        allowedMentions = { parse: ['everyone'] };
    } else if (settings.pingRole) {
        const role = guild.roles.cache.get(settings.pingRole);
        parts.push(mode === 'plain' ? `@${role ? role.name : 'роль'}` : `<@&${settings.pingRole}>`);
        allowedMentions = { roles: [settings.pingRole] };
    }
    const custom = applyPlaceholders(settings.content, ctx).trim();
    if (custom) parts.push(custom);
    const content = parts.join('\n').slice(0, 2000) || null;

    return { content, embed, allowedMentions };
}

// ---------- Отправка ----------

function getGuild(client, guildId) {
    if (!client || !client.isReady()) throw new Error('Discord-бот ещё не готов');
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Сервер не найден');
    return guild;
}

function friendlyError(err) {
    if (!err) return 'Неизвестная ошибка';
    if (err.code === 50013 || err.code === 50001) {
        return 'У бота нет доступа к каналу или права писать сообщения / встраивать ссылки';
    }
    if (err.code === 10003) return 'Канал не найден';
    return err.message || 'Неизвестная ошибка';
}

async function writeLog(guild, text) {
    if (!logFn) return;
    try {
        await logFn(guild, text, 'weekly_report');
    } catch (err) {
        console.warn('Не удалось записать событие отчёта в журнал:', err.message);
    }
}

async function sendReport(client, settings, guildId) {
    const guild = getGuild(client, guildId);
    if (!settings.channelId) throw new Error('Не выбран канал для отчёта');

    const channel = await client.channels.fetch(settings.channelId).catch(() => null);
    if (!channel) throw new Error('Канал не найден');
    if (!channel.isTextBased() || channel.guildId !== guild.id) {
        throw new Error('Этот канал недоступен: он не на вашем сервере или не текстовый');
    }

    const built = await buildMessage(guild, settings, 'discord');
    const message = await channel.send({
        content: built.content,
        embeds: [built.embed],
        allowedMentions: built.allowedMentions
    });
    return { guild, message };
}

// Ручная отправка с сайта (данные — из формы, даже если ещё не сохранены)
async function sendNow(client, draft, by, guildId) {
    const settings = store.sanitize(draft, store.getSettings(guildId));
    const { guild, message } = await sendReport(client, settings, guildId);
    store.updateState(guildId, { lastManualAt: Date.now() });
    await writeLog(guild, `📊 Еженедельный отчёт отправлен в <#${settings.channelId}> (вручную${by ? `, ${by}` : ''}).`);
    return message;
}

// Предпросмотр для сайта: то же самое сообщение, но с именами вместо упоминаний
async function buildPreview(client, draft, guildId) {
    const guild = getGuild(client, guildId);
    const settings = store.sanitize(draft, store.getSettings(guildId));
    const built = await buildMessage(guild, settings, 'plain');
    return { content: built.content, embed: built.embed.toJSON() };
}

// ---------- Планировщик ----------

async function tick(client) {
    if (tickRunning || !client || !client.isReady()) return;
    tickRunning = true;

    try {
        const allGuilds = store.getAll();
        const now = Date.now();

        for (const guildId of Object.keys(allGuilds)) {
            const settings = store.getSettings(guildId);
            if (!settings.enabled || !settings.channelId) continue;

            const state = store.getState(guildId);
            const slot = lastOccurrence(now, settings.dayOfWeek, settings.time, settings.timezone);
            if (!slot) continue;
            if (slot <= state.lastHandledSlot || slot < state.enabledSince) continue;

            const guild = client.guilds.cache.get(guildId);
            if (!guild) continue;

            if (now - slot <= GRACE_MS) {
                // Окно отправки открыто. При сбое повторяем на следующем тике, пока окно не закроется.
                try {
                    await sendReport(client, settings, guildId);
                    store.updateState(guildId, { lastHandledSlot: slot, lastSentAt: now, lastError: '' });
                    await writeLog(guild, `📊 Еженедельный отчёт отправлен в <#${settings.channelId}> (по расписанию).`);
                } catch (err) {
                    const text = friendlyError(err);
                    console.error('❌ Не удалось отправить еженедельный отчёт:', err.message);
                    store.updateState(guildId, { lastError: text });
                }
            } else {
                // Окно вышло (бот был выключен или отправка так и не удалась) — устаревший отчёт НЕ шлём
                const reason = state.lastError || 'бот был выключен или недоступен в назначенное время';
                const when = formatDateTime(slot, settings.timezone);
                const skipText = `⏭️ **Еженедельный отчёт пропущен.** Он был запланирован на ${when} (${settings.timezone}).\n` +
                                 `Причина: ${reason}.\nУстаревший отчёт не отправляется — следующий придёт по расписанию.`;
                store.updateState(guildId, { lastHandledSlot: slot, lastSkippedAt: now, lastSkipText: `${when}: ${reason}`, lastError: '' });
                await writeLog(guild, skipText);
            }
        }
    } catch (err) {
        console.error('❌ Ошибка планировщика еженедельного отчёта:', err);
    } finally {
        tickRunning = false;
    }
}

// Один раз подтягиваем в activity_totals данные за уже накопленные (до 90 дней) события,
// чтобы «топ за всё время» не начинался с нуля. GREATEST делает повторный запуск безопасным.
async function backfillTotals(client) {
    const allGuilds = store.getAll();

    for (const guildId of Object.keys(allGuilds)) {
        const state = store.getState(guildId);
        if (state.allTimeBackfilled) continue;

        try {
            await db.query(
                `INSERT INTO activity_totals (guild_id, user_id, messages_count)
                 SELECT guild_id, user_id, COUNT(*)::int FROM message_events WHERE guild_id = $1 GROUP BY guild_id, user_id
                 ON CONFLICT (guild_id, user_id) DO UPDATE
                 SET messages_count = GREATEST(activity_totals.messages_count, EXCLUDED.messages_count)`,
                [guildId]
            );
            await db.query(
                `INSERT INTO activity_totals (guild_id, user_id, voice_seconds)
                 SELECT guild_id, user_id, COALESCE(SUM(duration_seconds), 0)::bigint FROM voice_sessions WHERE guild_id = $1 GROUP BY guild_id, user_id
                 ON CONFLICT (guild_id, user_id) DO UPDATE
                 SET voice_seconds = GREATEST(activity_totals.voice_seconds, EXCLUDED.voice_seconds)`,
                [guildId]
            );
            store.updateState(guildId, { allTimeBackfilled: true });
            console.log(`📊 Топ «за всё время» для guild ${guildId}: стартовые данные подтянуты из накопленных событий.`);
        } catch (err) {
            console.error(`❌ Не удалось подготовить данные для топа за всё время для guild ${guildId} (повторю позже):`, err.message);
        }
    }
}

function register(client, sendLog) {
    logFn = sendLog || null;

    setTimeout(() => backfillTotals(client), 30 * 1000);
    setInterval(() => backfillTotals(client), 10 * 60 * 1000).unref();

    // Первая проверка через 15 секунд после старта — подхватит слот, который наступил во время простоя
    setTimeout(() => tick(client), 15 * 1000);
    setInterval(() => tick(client), CHECK_INTERVAL_MS);
}

// Данные для карточки статуса на сайте
function getStatus(guildId) {
    const settings = store.getSettings(guildId);
    const state = store.getState(guildId);
    const next = settings.enabled
        ? nextOccurrence(Date.now(), settings.dayOfWeek, settings.time, settings.timezone)
        : null;
    return {
        nextRunAt: next,
        nextRunText: next ? formatDateTime(next, settings.timezone) : '',
        lastSentAt: state.lastSentAt || 0,
        lastSkippedAt: state.lastSkippedAt || 0,
        lastSkipText: state.lastSkipText || '',
        lastError: state.lastError || ''
    };
}

module.exports = {
    register,
    sendNow,
    buildPreview,
    getStatus,
    friendlyError
};