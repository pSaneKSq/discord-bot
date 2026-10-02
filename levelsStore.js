const db = require('./db.js');

// Формула MEE6 для расчета XP для уровня
function calculateXpForLevel(level) {
    if (level === 0) return 0;
    return 5 * Math.pow(level, 2) + 50 * level + 100;
}

// Обратная формула для определения уровня по XP
function calculateLevel(xp) {
    // Убеждаемся что XP - это число
    const xpNum = Number(xp) || 0;
    let level = 0;
    // Проверяем каждый уровень
    while (xpNum >= calculateXpForLevel(level + 1)) {
        level++;
    }
    return level;
}

// Расчет прогресса до следующего уровня
function calculateLevelProgress(xp, level) {
    const currentLevelXp = calculateXpForLevel(level);
    const nextLevelXp = calculateXpForLevel(level + 1);
    const xpInCurrentLevel = xp - currentLevelXp;
    const xpNeededForNext = nextLevelXp - currentLevelXp;
    return {
        current: xpInCurrentLevel,
        needed: xpNeededForNext,
        percentage: Math.min(100, Math.max(0, (xpInCurrentLevel / xpNeededForNext) * 100))
    };
}

// Получить настройки уровней для сервера
async function getLevelSettings(guildId) {
    try {
        const result = await db.query(
            'SELECT * FROM level_settings WHERE guild_id = $1',
            [guildId]
        );

        if (result.rows.length === 0) {
            // Создаем настройки по умолчанию
            const defaultSettings = {
                guild_id: guildId,
                enabled: true,
                xp_per_message_min: 15,
                xp_per_message_max: 25,
                xp_cooldown_seconds: 60,
                level_up_channel_id: null,
                level_up_message: '🎉 Поздравляем {user} с достижением уровня {level}!',
                level_up_mode: 'current',
                no_xp_roles: [],
                no_xp_channels: []
            };

            await db.query(
                `INSERT INTO level_settings (guild_id, enabled, xp_per_message_min, xp_per_message_max,
                 xp_cooldown_seconds, level_up_channel_id, level_up_message, level_up_mode, no_xp_roles, no_xp_channels)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 ON CONFLICT (guild_id) DO NOTHING`,
                [guildId, defaultSettings.enabled, defaultSettings.xp_per_message_min,
                 defaultSettings.xp_per_message_max, defaultSettings.xp_cooldown_seconds,
                 defaultSettings.level_up_channel_id, defaultSettings.level_up_message,
                 defaultSettings.level_up_mode, defaultSettings.no_xp_roles, defaultSettings.no_xp_channels]
            );

            return defaultSettings;
        }

        return result.rows[0];
    } catch (err) {
        console.error('Ошибка получения настроек уровней:', err.message);
        return null;
    }
}

// Обновить настройки уровней
async function updateLevelSettings(guildId, settings) {
    try {
        // Сначала создаём запись, если её нет
        await getLevelSettings(guildId);

        const result = await db.query(
            `UPDATE level_settings
             SET enabled = $2, xp_per_message_min = $3, xp_per_message_max = $4,
                 xp_cooldown_seconds = $5, level_up_channel_id = $6, level_up_message = $7,
                 level_up_mode = $8, no_xp_roles = $9, no_xp_channels = $10
             WHERE guild_id = $1
             RETURNING *`,
            [guildId, settings.enabled, settings.xp_per_message_min, settings.xp_per_message_max,
             settings.xp_cooldown_seconds, settings.level_up_channel_id, settings.level_up_message,
             settings.level_up_mode, settings.no_xp_roles || [], settings.no_xp_channels || []]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка обновления настроек уровней:', err.message);
        throw err;
    }
}

// Получить уровень пользователя
async function getUserLevel(guildId, userId) {
    try {
        const result = await db.query(
            'SELECT * FROM user_levels WHERE guild_id = $1 AND user_id = $2',
            [guildId, userId]
        );

        if (result.rows.length === 0) {
            // Создаем запись по умолчанию с уровнем 0
            await db.query(
                `INSERT INTO user_levels (guild_id, user_id, xp, level, total_messages, level_up_count)
                 VALUES ($1, $2, 0, 0, 0, 0)
                 ON CONFLICT (guild_id, user_id) DO NOTHING`,
                [guildId, userId]
            );

            return {
                user_id: userId,
                guild_id: guildId,
                xp: 0,
                level: 0,
                total_messages: 0,
                last_xp_at: null,
                level_up_count: 0
            };
        }

        const userLevel = result.rows[0];
        // Приводим к числам для надежности
        userLevel.xp = Number(userLevel.xp) || 0;
        userLevel.level = Number(userLevel.level) || 0;
        userLevel.total_messages = Number(userLevel.total_messages) || 0;
        userLevel.level_up_count = Number(userLevel.level_up_count) || 0;

        return userLevel;
    } catch (err) {
        console.error('Ошибка получения уровня пользователя:', err.message);
        return null;
    }
}

// Добавить XP пользователю
async function addXp(guildId, userId, xpAmount) {
    try {
        await getUserLevel(guildId, userId); // создаёт запись, если её нет
        const upd = await db.query(
            `UPDATE user_levels
             SET xp = xp + $3, total_messages = total_messages + 1, last_xp_at = NOW()
             WHERE guild_id = $1 AND user_id = $2 RETURNING *`,
            [guildId, userId, xpAmount]
        );
        let user = upd.rows[0];
        const previousLevel = Number(user.level);
        const newLevel = calculateLevel(Number(user.xp));
        const levelUp = newLevel > previousLevel;
        if (newLevel !== previousLevel) {
            const r = await db.query(
                `UPDATE user_levels SET level = $3, level_up_count = level_up_count + $4
                 WHERE guild_id = $1 AND user_id = $2 RETURNING *`,
                [guildId, userId, newLevel, levelUp ? 1 : 0]
            );
            user = r.rows[0];
        }
        return { user, levelUp, previousLevel, newLevel };
    } catch (err) {
        console.error('Ошибка добавления XP:', err.message);
        throw err;
    }
}

// Вручную изменить XP пользователя
async function setUserXp(guildId, userId, xp) {
    try {
        xp = Math.max(0, parseInt(xp, 10) || 0);
        const result = await db.query(
            `INSERT INTO user_levels (guild_id, user_id, xp, level, total_messages, level_up_count)
             VALUES ($1, $2, $3, $4, 0, 0)
             ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = $3, level = $4
             RETURNING *`,
            [guildId, userId, xp, calculateLevel(xp)]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка установки XP:', err.message);
        throw err;
    }
}

// Получить топ пользователей по XP
async function getLeaderboard(guildId, limit = 10) {
    try {
        const result = await db.query(
            `SELECT user_id, xp, level, total_messages, level_up_count 
             FROM user_levels 
             WHERE guild_id = $1 
             ORDER BY xp DESC 
             LIMIT $2`,
            [guildId, limit]
        );
        return result.rows;
    } catch (err) {
        console.error('Ошибка получения лидерборда:', err.message);
        return [];
    }
}

// Получить все награды за уровни
async function getLevelRewards(guildId) {
    try {
        const result = await db.query('SELECT * FROM level_rewards WHERE guild_id = $1 ORDER BY level ASC', [guildId]);
        return result.rows;
    } catch (err) {
        console.error('Ошибка получения наград:', err.message);
        return [];
    }
}

// Добавить награду за уровень
async function addLevelReward(guildId, level, roleId, removePrevious = false) {
    try {
        const result = await db.query(
            `INSERT INTO level_rewards (guild_id, level, role_id, remove_previous)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (guild_id, level) DO UPDATE SET role_id = $3, remove_previous = $4
             RETURNING *`,
            [guildId, level, roleId, removePrevious]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка добавления награды:', err.message);
        throw err;
    }
}

// Удалить награду за уровень
async function removeLevelReward(guildId, level) {
    try {
        await db.query('DELETE FROM level_rewards WHERE guild_id = $1 AND level = $2', [guildId, level]);
        return true;
    } catch (err) {
        console.error('Ошибка удаления награды:', err.message);
        throw err;
    }
}

// Получить награду для конкретного уровня
async function getLevelReward(guildId, level) {
    try {
        const result = await db.query('SELECT * FROM level_rewards WHERE guild_id = $1 AND level = $2', [guildId, level]);
        return result.rows[0] || null;
    } catch (err) {
        console.error('Ошибка получения награды уровня:', err.message);
        return null;
    }
}

// Получить статистику уровней сервера
async function getLevelStats(guildId) {
    try {
        const result = await db.query(
            `SELECT
                COUNT(*) as total_users,
                AVG(level) as average_level,
                MAX(level) as max_level,
                SUM(xp) as total_xp,
                SUM(total_messages) as total_messages
             FROM user_levels
             WHERE guild_id = $1`,
            [guildId]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка получения статистики уровней:', err.message);
        return null;
    }
}

// Сбросить XP всех пользователей
async function resetAllXp(guildId) {
    try {
        const result = await db.query(
            `UPDATE user_levels
             SET xp = 0, level = 0, total_messages = 0, level_up_count = 0, last_xp_at = NULL
             WHERE guild_id = $1
             RETURNING *`,
            [guildId]
        );
        console.log(`Сброшен XP для ${result.rowCount} пользователей`);
        return { success: true, count: result.rowCount };
    } catch (err) {
        console.error('Ошибка сброса всех XP:', err.message);
        throw err;
    }
}

// Сбросить XP конкретного пользователя
async function resetUserXp(guildId, userId) {
    try {
        const result = await db.query(
            `UPDATE user_levels
             SET xp = 0, level = 0, total_messages = 0, level_up_count = 0, last_xp_at = NULL
             WHERE guild_id = $1 AND user_id = $2
             RETURNING *`,
            [guildId, userId]
        );
        if (result.rows.length === 0) {
            throw new Error('Пользователь не найден');
        }
        console.log(`Сброшен XP для пользователя ${userId}`);
        return { success: true, user: result.rows[0] };
    } catch (err) {
        console.error('Ошибка сброса XP пользователя:', err.message);
        throw err;
    }
}

module.exports = {
    calculateXpForLevel,
    calculateLevel,
    calculateLevelProgress,
    getLevelSettings,
    updateLevelSettings,
    getUserLevel,
    addXp,
    setUserXp,
    getLeaderboard,
    getLevelRewards,
    addLevelReward,
    removeLevelReward,
    getLevelReward,
    getLevelStats,
    resetAllXp,
    resetUserXp
};