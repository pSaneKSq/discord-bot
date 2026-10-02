const db = require('./db.js');
const swearWordsStore = require('./swearWordsStore.js');

function daysToInterval(days) {
    const n = parseInt(days, 10);
    return Number.isFinite(n) && n > 0 ? n : 7;
}

function pctChange(curr, prev) {
    if (prev === 0) return curr > 0 ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 100);
}

// Общая сводка + сравнение с предыдущим таким же периодом (для стрелочек роста ▲▼)
async function getOverview(guildId, days) {
    const range = daysToInterval(days);

    async function periodStats(startOffsetDays, endOffsetDays) {
        const [messagesRes, voiceRes, activeRes, joinsRes, leavesRes] = await Promise.all([
            db.query(`SELECT COUNT(*)::int AS count FROM message_events WHERE guild_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval AND created_at < NOW() - ($3 || ' days')::interval`, [guildId, startOffsetDays, endOffsetDays]),
            db.query(`SELECT COALESCE(SUM(duration_seconds), 0)::int AS seconds FROM voice_sessions WHERE guild_id = $1 AND started_at >= NOW() - ($2 || ' days')::interval AND started_at < NOW() - ($3 || ' days')::interval`, [guildId, startOffsetDays, endOffsetDays]),
            db.query(`SELECT COUNT(DISTINCT user_id)::int AS count FROM (
                SELECT user_id FROM message_events WHERE guild_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval AND created_at < NOW() - ($3 || ' days')::interval
                UNION
                SELECT user_id FROM voice_sessions WHERE guild_id = $1 AND started_at >= NOW() - ($2 || ' days')::interval AND started_at < NOW() - ($3 || ' days')::interval
            ) t`, [guildId, startOffsetDays, endOffsetDays]),
            db.query(`SELECT COUNT(*)::int AS count FROM member_events WHERE guild_id = $1 AND event_type = 'join' AND created_at >= NOW() - ($2 || ' days')::interval AND created_at < NOW() - ($3 || ' days')::interval`, [guildId, startOffsetDays, endOffsetDays]),
            db.query(`SELECT COUNT(*)::int AS count FROM member_events WHERE guild_id = $1 AND event_type = 'leave' AND created_at >= NOW() - ($2 || ' days')::interval AND created_at < NOW() - ($3 || ' days')::interval`, [guildId, startOffsetDays, endOffsetDays])
        ]);
        return {
            messages: messagesRes.rows[0].count,
            voiceHours: Math.round((voiceRes.rows[0].seconds / 3600) * 100) / 100,
            active: activeRes.rows[0].count,
            joins: joinsRes.rows[0].count,
            leaves: leavesRes.rows[0].count
        };
    }

    const current = await periodStats(range, 0);
    const previous = await periodStats(range * 2, range);

    return {
        totalMessages: current.messages,
        totalVoiceHours: current.voiceHours,
        activeMembers: current.active,
        joins: current.joins,
        leaves: current.leaves,
        trends: {
            messages: pctChange(current.messages, previous.messages),
            voiceHours: pctChange(current.voiceHours, previous.voiceHours),
            active: pctChange(current.active, previous.active),
            joins: pctChange(current.joins, previous.joins),
            leaves: pctChange(current.leaves, previous.leaves)
        }
    };
}

// Ежедневный ряд значений для графиков.
// Пустые дни добавляются со значением 0, чтобы графики не «рвались».
async function getDailySeries(guildId, days, type) {
    const range = daysToInterval(days);
    let query;

    if (type === 'messages') {
        query = `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS value
                 FROM message_events WHERE guild_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
                 GROUP BY day ORDER BY day ASC`;
    } else if (type === 'voice') {
        query = `SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day, ROUND(SUM(duration_seconds) / 3600.0, 2) AS value
                 FROM voice_sessions WHERE guild_id = $1 AND started_at >= NOW() - ($2 || ' days')::interval
                 GROUP BY day ORDER BY day ASC`;
    } else if (type === 'joins') {
        query = `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS value
                 FROM member_events WHERE guild_id = $1 AND event_type = 'join' AND created_at >= NOW() - ($2 || ' days')::interval
                 GROUP BY day ORDER BY day ASC`;
    } else if (type === 'leaves') {
        query = `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS value
                 FROM member_events WHERE guild_id = $1 AND event_type = 'leave' AND created_at >= NOW() - ($2 || ' days')::interval
                 GROUP BY day ORDER BY day ASC`;
    } else {
        return [];
    }

    const res = await db.query(query, [guildId, range]);

    try {
        const daysRes = await db.query(
            `SELECT to_char(d, 'YYYY-MM-DD') AS day
             FROM generate_series(date_trunc('day', NOW()) - ($1 || ' days')::interval, date_trunc('day', NOW()), interval '1 day') AS d
             ORDER BY d ASC`,
            [range]
        );
        const byDay = new Map(res.rows.map(r => [r.day, r.value]));
        return daysRes.rows.map(r => ({ day: r.day, value: byDay.has(r.day) ? byDay.get(r.day) : 0 }));
    } catch (err) {
        console.error('Не удалось заполнить пустые дни, отдаю ряд как есть:', err.message);
        return res.rows;
    }
}

async function getTopMembers(guildId, days, metric, limit = 10) {
    const range = daysToInterval(days);
    const query = metric === 'voice'
        ? `SELECT user_id, ROUND(SUM(duration_seconds) / 3600.0, 2) AS value
           FROM voice_sessions WHERE guild_id = $1 AND started_at >= NOW() - ($2 || ' days')::interval
           GROUP BY user_id ORDER BY value DESC LIMIT $3`
        : `SELECT user_id, COUNT(*)::int AS value
           FROM message_events WHERE guild_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
           GROUP BY user_id ORDER BY value DESC LIMIT $3`;

    const res = await db.query(query, [guildId, range, limit]);
    return res.rows;
}

async function getTopChannels(guildId, days, metric, limit = 10) {
    const range = daysToInterval(days);
    const query = metric === 'voice'
        ? `SELECT channel_id, ROUND(SUM(duration_seconds) / 3600.0, 2) AS value
           FROM voice_sessions WHERE guild_id = $1 AND started_at >= NOW() - ($2 || ' days')::interval
           GROUP BY channel_id ORDER BY value DESC LIMIT $3`
        : `SELECT channel_id, COUNT(*)::int AS value
           FROM message_events WHERE guild_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
           GROUP BY channel_id ORDER BY value DESC LIMIT $3`;

    const res = await db.query(query, [guildId, range, limit]);
    return res.rows;
}

async function getStatusSeries(guildId, days) {
    const range = daysToInterval(days);
    const res = await db.query(
        `SELECT to_char(captured_at, 'YYYY-MM-DD HH24:MI') AS point, online_count, idle_count, dnd_count, offline_count
         FROM presence_snapshots WHERE guild_id = $1 AND captured_at >= NOW() - ($2 || ' days')::interval
         ORDER BY captured_at ASC`,
        [guildId, range]
    );
    return res.rows;
}

// Тепловая карта: активность по дню недели / часу
async function getHeatmap(guildId, days) {
    const range = daysToInterval(days);
    const res = await db.query(
        `SELECT EXTRACT(DOW FROM created_at)::int AS weekday, EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS value
         FROM message_events WHERE guild_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
         GROUP BY weekday, hour`,
        [guildId, range]
    );
    return res.rows;
}

// Статистика матов
async function getSwearStats(guildId, days) {
    const range = daysToInterval(days);

    const current = await swearWordsStore.getSwearOverview(guildId, range);
    const topSwearers = await swearWordsStore.getTopSwearers(guildId, range, 10);
    const dailySeries = await swearWordsStore.getSwearDailySeries(guildId, range);
    const mostFrequentWord = await swearWordsStore.getMostFrequentSwearWord(guildId, range);

    return {
        total: current.total,
        trend: current.trend,
        topSwearers,
        dailySeries,
        mostFrequentWord
    };
}

module.exports = {
    getOverview,
    getDailySeries,
    getTopMembers,
    getTopChannels,
    getStatusSeries,
    getHeatmap,
    getSwearStats
};