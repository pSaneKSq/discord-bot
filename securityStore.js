const db = require('./db.js');

// Получить настройки защиты для сервера
async function getSecuritySettings(guildId) {
    try {
        const result = await db.query(
            'SELECT * FROM security_settings WHERE guild_id = $1',
            [guildId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('Ошибка получения настроек защиты:', err.message);
        return null;
    }
}

// Создать или обновить настройки защиты
async function upsertSecuritySettings(guildId, settings) {
    try {
        const result = await db.query(
            `INSERT INTO security_settings (guild_id, enabled, notification_channel_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (guild_id)
             DO UPDATE SET enabled = $2, notification_channel_id = $3, updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [
                guildId,
                settings.enabled !== undefined ? settings.enabled : true,
                settings.notification_channel_id || null
            ]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка сохранения настроек защиты:', err.message);
        throw err;
    }
}

// Получить все ограничения для пользователя
async function getUserRestrictions(guildId, userId) {
    try {
        const result = await db.query(
            'SELECT * FROM security_restrictions WHERE guild_id = $1 AND user_id = $2',
            [guildId, userId]
        );
        return result.rows;
    } catch (err) {
        console.error('Ошибка получения ограничений пользователя:', err.message);
        return [];
    }
}

// Получить все ограничения для сервера
async function getAllRestrictions(guildId) {
    try {
        const result = await db.query(
            'SELECT * FROM security_restrictions WHERE guild_id = $1 ORDER BY created_at DESC',
            [guildId]
        );
        return result.rows;
    } catch (err) {
        console.error('Ошибка получения всех ограничений:', err.message);
        return [];
    }
}

// Добавить ограничение для пользователя
async function addRestriction(guildId, userId, userName, restrictionType, restrictionMethod = 'block', notificationEnabled = false) {
    try {
        const result = await db.query(
            `INSERT INTO security_restrictions (guild_id, user_id, user_name, restriction_type, restriction_method, notification_enabled)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (guild_id, user_id, restriction_type)
             DO UPDATE SET restriction_method = $5, notification_enabled = $6, updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [guildId, userId, userName, restrictionType, restrictionMethod, notificationEnabled]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка добавления ограничения:', err.message);
        throw err;
    }
}

// Удалить ограничение
async function removeRestriction(guildId, userId, restrictionType) {
    try {
        await db.query(
            'DELETE FROM security_restrictions WHERE guild_id = $1 AND user_id = $2 AND restriction_type = $3',
            [guildId, userId, restrictionType]
        );
        return true;
    } catch (err) {
        console.error('Ошибка удаления ограничения:', err.message);
        throw err;
    }
}

// Удалить все ограничения пользователя
async function removeAllUserRestrictions(guildId, userId) {
    try {
        await db.query(
            'DELETE FROM security_restrictions WHERE guild_id = $1 AND user_id = $2',
            [guildId, userId]
        );
        return true;
    } catch (err) {
        console.error('Ошибка удаления всех ограничений пользователя:', err.message);
        throw err;
    }
}

// Проверить есть ли ограничение определенного типа
async function hasRestriction(guildId, userId, restrictionType) {
    try {
        const result = await db.query(
            'SELECT * FROM security_restrictions WHERE guild_id = $1 AND user_id = $2 AND restriction_type = $3',
            [guildId, userId, restrictionType]
        );
        return result.rows.length > 0 ? result.rows[0] : null;
    } catch (err) {
        console.error('Ошибка проверки ограничения:', err.message);
        return null;
    }
}

// Получить белый список
async function getWhitelist(guildId) {
    try {
        const result = await db.query(
            'SELECT * FROM security_whitelist WHERE guild_id = $1 ORDER BY created_at DESC',
            [guildId]
        );
        return result.rows;
    } catch (err) {
        console.error('Ошибка получения белого списка:', err.message);
        return [];
    }
}

// Проверить в белом списке
async function isInWhitelist(guildId, userId) {
    try {
        const result = await db.query(
            'SELECT * FROM security_whitelist WHERE guild_id = $1 AND user_id = $2',
            [guildId, userId]
        );
        return result.rows.length > 0;
    } catch (err) {
        console.error('Ошибка проверки белого списка:', err.message);
        return false;
    }
}

// Добавить в белый список
async function addToWhitelist(guildId, userId, userName, isPermanent = true, addedBy = null) {
    try {
        const result = await db.query(
            `INSERT INTO security_whitelist (guild_id, user_id, user_name, is_permanent, added_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (guild_id, user_id)
             DO UPDATE SET user_name = $3, is_permanent = $4, added_by = $5
             RETURNING *`,
            [guildId, userId, userName, isPermanent, addedBy]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка добавления в белый список:', err.message);
        throw err;
    }
}

// Удалить из белого списка
async function removeFromWhitelist(guildId, userId) {
    try {
        await db.query(
            'DELETE FROM security_whitelist WHERE guild_id = $1 AND user_id = $2',
            [guildId, userId]
        );
        return true;
    } catch (err) {
        console.error('Ошибка удаления из белого списка:', err.message);
        throw err;
    }
}

// Добавить запись в лог защиты
async function addSecurityLog(guildId, userId, userName, actionType, restrictionType, result, details = null) {
    try {
        const logResult = await db.query(
            `INSERT INTO security_logs (guild_id, user_id, user_name, action_type, restriction_type, result, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [guildId, userId, userName, actionType, restrictionType, result, details]
        );
        return logResult.rows[0];
    } catch (err) {
        console.error('Ошибка добавления лога защиты:', err.message);
        throw err;
    }
}

// Получить логи защиты
async function getSecurityLogs(guildId, limit = 100) {
    try {
        const result = await db.query(
            'SELECT * FROM security_logs WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2',
            [guildId, limit]
        );
        return result.rows;
    } catch (err) {
        console.error('Ошибка получения логов защиты:', err.message);
        return [];
    }
}

// Создать бэкап настроек
async function createBackup(guildId, backupType, backupData, createdBy = null) {
    try {
        const result = await db.query(
            `INSERT INTO security_backups (guild_id, backup_type, backup_data, created_by)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [guildId, backupType, JSON.stringify(backupData), createdBy]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка создания бэкапа:', err.message);
        throw err;
    }
}

// Получить бэкапы
async function getBackups(guildId, limit = 20) {
    try {
        const result = await db.query(
            'SELECT * FROM security_backups WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2',
            [guildId, limit]
        );
        return result.rows;
    } catch (err) {
        console.error('Ошибка получения бэкапов:', err.message);
        return [];
    }
}

// Удалить старые бэкапы (старше N дней)
async function cleanupOldBackups(guildId, days = 30) {
    try {
        await db.query(
            `DELETE FROM security_backups WHERE guild_id = $1 AND created_at < NOW() - make_interval(days => $2::int)`,
            [guildId, days]
        );
        return true;
    } catch (err) {
        console.error('Ошибка очистки старых бэкапов:', err.message);
        return false;
    }
}

// Создать голосование
async function createVote(guildId, voteId, actionType, targetUserId, targetUserName, executorUserId, executorUserName, details, expiresAt) {
    try {
        const result = await db.query(
            `INSERT INTO security_votes (guild_id, vote_id, action_type, target_user_id, target_user_name, executor_user_id, executor_user_name, details, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [guildId, voteId, actionType, targetUserId, targetUserName, executorUserId, executorUserName, details, expiresAt]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка создания голосования:', err.message);
        throw err;
    }
}

// Получить голосование по ID
async function getVote(guildId, voteId) {
    const result = await db.query('SELECT * FROM security_votes WHERE vote_id = $1 AND guild_id = $2', [voteId, guildId]);
    return result.rows[0] || null;
}

// Получить ожидающие голосования
async function getPendingVotes(guildId) {
    try {
        const result = await db.query(
            'SELECT * FROM security_votes WHERE guild_id = $1 AND status = $2 ORDER BY created_at DESC',
            [guildId, 'pending']
        );
        return result.rows;
    } catch (err) {
        console.error('Ошибка получения ожидающих голосований:', err.message);
        return [];
    }
}

// Добавить ответ на голосование
async function addVoteResponse(voteId, voterId, voterName, vote) {
    try {
        const result = await db.query(
            `INSERT INTO security_vote_responses (vote_id, voter_id, voter_name, vote)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (vote_id, voter_id)
             DO UPDATE SET vote = $4, voter_name = $3, voted_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [voteId, voterId, voterName, vote]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка добавления ответа на голосование:', err.message);
        throw err;
    }
}

// Получить все ответы для голосования
async function getVoteResponses(voteId) {
    try {
        const result = await db.query(
            'SELECT * FROM security_vote_responses WHERE vote_id = $1',
            [voteId]
        );
        return result.rows;
    } catch (err) {
        console.error('Ошибка получения ответов на голосование:', err.message);
        return [];
    }
}

// Обновить статус голосования
async function updateVoteStatus(guildId, voteId, status, decision = null) {
    try {
        const result = await db.query(
            `UPDATE security_votes
             SET status = $1, decision = $2, decided_at = CURRENT_TIMESTAMP
             WHERE vote_id = $3 AND guild_id = $4
             RETURNING *`,
            [status, decision, voteId, guildId]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка обновления статуса голосования:', err.message);
        throw err;
    }
}

// Удалить старые голосования
async function cleanupOldVotes(guildId, days = 7) {
    try {
        await db.query(
            'DELETE FROM security_votes WHERE guild_id = $1 AND created_at < NOW() - INTERVAL \'$2 days\'',
            [guildId, days]
        );
        return true;
    } catch (err) {
        console.error('Ошибка очистки старых голосований:', err.message);
        return false;
    }
}

module.exports = {
    getSecuritySettings,
    upsertSecuritySettings,
    getUserRestrictions,
    getAllRestrictions,
    addRestriction,
    removeRestriction,
    removeAllUserRestrictions,
    hasRestriction,
    getWhitelist,
    isInWhitelist,
    addToWhitelist,
    removeFromWhitelist,
    addSecurityLog,
    getSecurityLogs,
    createBackup,
    getBackups,
    cleanupOldBackups,
    createVote,
    getVote,
    getPendingVotes,
    addVoteResponse,
    getVoteResponses,
    updateVoteStatus,
    cleanupOldVotes
};
