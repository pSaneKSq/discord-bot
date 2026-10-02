const db = require('./db.js');

// Получить все слова-маты для сервера
async function getSwearWords(guildId) {
    try {
        const result = await db.query(
            `SELECT word FROM swear_words WHERE guild_id = $1 ORDER BY word`,
            [guildId]
        );
        return result.rows.map(row => row.word.toLowerCase());
    } catch (err) {
        console.error('Ошибка получения списка матов:', err.message);
        return [];
    }
}

// Добавить слово-мат
async function addSwearWord(guildId, word, addedBy) {
    try {
        const result = await db.query(
            `INSERT INTO swear_words (guild_id, word, added_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (guild_id, word) DO NOTHING
             RETURNING *`,
            [guildId, word.toLowerCase(), addedBy]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('Ошибка добавления слова-мата:', err.message);
        throw err;
    }
}

// Удалить слово-мат
async function removeSwearWord(guildId, word) {
    try {
        await db.query(
            `DELETE FROM swear_words WHERE guild_id = $1 AND word = $2`,
            [guildId, word.toLowerCase()]
        );
        return true;
    } catch (err) {
        console.error('Ошибка удаления слова-мата:', err.message);
        throw err;
    }
}

// Записать событие использования мата
async function recordSwearEvent(guildId, userId, channelId, word, messageId) {
    try {
        await db.query(
            `INSERT INTO swear_events (guild_id, user_id, channel_id, word, message_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [guildId, userId, channelId, word.toLowerCase(), messageId]
        );
    } catch (err) {
        console.error('Ошибка записи события мата:', err.message);
    }
}

// Получить статистику матов по пользователю
async function getUserSwearStats(guildId, userId, days = 30) {
    try {
        const result = await db.query(
            `SELECT COUNT(*)::int AS count, 
                    COUNT(DISTINCT word)::int AS unique_words
             FROM swear_events 
             WHERE guild_id = $1 AND user_id = $2 
             AND created_at >= NOW() - ($3 || ' days')::interval`,
            [guildId, userId, days]
        );
        return result.rows[0] || { count: 0, unique_words: 0 };
    } catch (err) {
        console.error('Ошибка получения статистики матов пользователя:', err.message);
        return { count: 0, unique_words: 0 };
    }
}

// Получить топ пользователей по матам
async function getTopSwearers(guildId, days = 30, limit = 10) {
    try {
        const result = await db.query(
            `SELECT user_id, COUNT(*)::int AS count
             FROM swear_events 
             WHERE guild_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
             GROUP BY user_id 
             ORDER BY count DESC 
             LIMIT $3`,
            [guildId, days, limit]
        );
        return result.rows;
    } catch (err) {
        console.error('Ошибка получения топа матерящихся:', err.message);
        return [];
    }
}

// Получить общую статистику матов за период
async function getSwearOverview(guildId, days = 30) {
    try {
        const range = parseInt(days, 10) || 30;
        
        const [currentRes, previousRes] = await Promise.all([
            db.query(
                `SELECT COUNT(*)::int AS count 
                 FROM swear_events 
                 WHERE guild_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
                [guildId, range]
            ),
            db.query(
                `SELECT COUNT(*)::int AS count 
                 FROM swear_events 
                 WHERE guild_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval 
                 AND created_at < NOW() - ($3 || ' days')::interval`,
                [guildId, range * 2, range]
            )
        ]);

        const current = currentRes.rows[0].count;
        const previous = previousRes.rows[0].count;
        
        let trend = 0;
        if (previous > 0) {
            trend = Math.round(((current - previous) / previous) * 100);
        } else if (current > 0) {
            trend = 100;
        }

        return {
            total: current,
            trend
        };
    } catch (err) {
        console.error('Ошибка получения общей статистики матов:', err.message);
        return { total: 0, trend: 0 };
    }
}

// Получить ежедневную статистику матов для графика
async function getSwearDailySeries(guildId, days = 30) {
    try {
        const range = parseInt(days, 10) || 30;

        const res = await db.query(
            `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS value
             FROM swear_events WHERE guild_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
             GROUP BY day ORDER BY day ASC`,
            [guildId, range]
        );

        const daysRes = await db.query(
            `SELECT to_char(d, 'YYYY-MM-DD') AS day
             FROM generate_series(date_trunc('day', NOW()) - ($1 || ' days')::interval, date_trunc('day', NOW()), interval '1 day') AS d
             ORDER BY d ASC`,
            [range]
        );

        const byDay = new Map(res.rows.map(r => [r.day, r.value]));
        return daysRes.rows.map(r => ({ day: r.day, value: byDay.has(r.day) ? byDay.get(r.day) : 0 }));
    } catch (err) {
        console.error('Ошибка получения ежедневной статистики матов:', err.message);
        return [];
    }
}

// Получить самое частое слово-мат
async function getMostFrequentSwearWord(guildId, days = 30) {
    try {
        const range = parseInt(days, 10) || 30;

        const res = await db.query(
            `SELECT word, COUNT(*)::int AS count
             FROM swear_events
             WHERE guild_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
             GROUP BY word
             ORDER BY count DESC
             LIMIT 1`,
            [guildId, range]
        );

        if (res.rows.length === 0) {
            return null;
        }

        return { word: res.rows[0].word, count: res.rows[0].count };
    } catch (err) {
        console.error('Ошибка получения самого частого слова-мата:', err.message);
        return null;
    }
}

module.exports = {
    getSwearWords,
    addSwearWord,
    removeSwearWord,
    recordSwearEvent,
    getUserSwearStats,
    getTopSwearers,
    getSwearOverview,
    getSwearDailySeries,
    getMostFrequentSwearWord
};
