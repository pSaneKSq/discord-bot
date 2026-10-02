const db = require('./db.js');

const SELECT_WITH_MAPPINGS = `
    SELECT rr.*,
           COALESCE(
               json_agg(
                   json_build_object('id', rrm.id, 'emoji', rrm.emoji, 'role_id', rrm.role_id, 'label', rrm.label)
                   ORDER BY rrm.id
               ) FILTER (WHERE rrm.id IS NOT NULL),
               '[]'::json
           ) AS mappings
    FROM reaction_roles rr
    LEFT JOIN reaction_role_mappings rrm ON rr.id = rrm.reaction_role_id`;

async function getReactionRoles(guildId) {
    try {
        const result = await db.query(
            `${SELECT_WITH_MAPPINGS} WHERE rr.guild_id = $1 GROUP BY rr.id ORDER BY rr.created_at DESC`,
            [guildId]
        );
        return result.rows;
    } catch (err) {
        console.error('Ошибка получения авторолей:', err.message);
        return [];
    }
}

async function getReactionRoleById(guildId, id) {
    try {
        const result = await db.query(
            `${SELECT_WITH_MAPPINGS} WHERE rr.id = $1 AND rr.guild_id = $2 GROUP BY rr.id`,
            [id, guildId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('Ошибка получения автороли по ID:', err.message);
        return null;
    }
}

async function getReactionRoleByMessage(guildId, messageId) {
    try {
        const result = await db.query(
            `${SELECT_WITH_MAPPINGS} WHERE rr.message_id = $1 AND rr.guild_id = $2 GROUP BY rr.id`,
            [messageId, guildId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('Ошибка получения автороли по message_id:', err.message);
        return null;
    }
}

async function createReactionRole(guildId, title, description, color, image, channelId = null, messageId = null) {
    try {
        const result = await db.query(
            `INSERT INTO reaction_roles (guild_id, channel_id, message_id, title, description, color, image)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [guildId, channelId, messageId, title, description, color, image]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка создания автороли:', err.message);
        throw err;
    }
}

async function updateReactionRole(guildId, id, title, description, color, image) {
    try {
        const result = await db.query(
            `UPDATE reaction_roles SET title = $3, description = $4, color = $5, image = $6
             WHERE id = $1 AND guild_id = $2 RETURNING *`,
            [id, guildId, title, description, color, image]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка обновления автороли:', err.message);
        throw err;
    }
}

async function deleteReactionRole(guildId, id) {
    try {
        const result = await db.query('DELETE FROM reaction_roles WHERE id = $1 AND guild_id = $2', [id, guildId]);
        return result.rowCount > 0;
    } catch (err) {
        console.error('Ошибка удаления автороли:', err.message);
        throw err;
    }
}

// Маппинг добавляется, только если автороль принадлежит этому серверу
async function addMapping(guildId, reactionRoleId, emoji, roleId, label) {
    try {
        const result = await db.query(
            `INSERT INTO reaction_role_mappings (reaction_role_id, emoji, role_id, label)
             SELECT id, $3, $4, $5 FROM reaction_roles WHERE id = $1 AND guild_id = $2
             ON CONFLICT (reaction_role_id, emoji)
             DO UPDATE SET role_id = EXCLUDED.role_id, label = EXCLUDED.label
             RETURNING *`,
            [reactionRoleId, guildId, emoji, roleId, label]
        );
        if (!result.rows[0]) throw new Error('Автороль не найдена');
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка добавления маппинга:', err.message);
        throw err;
    }
}

async function deleteMapping(guildId, mappingId) {
    try {
        const result = await db.query(
            `DELETE FROM reaction_role_mappings m
             USING reaction_roles rr
             WHERE m.id = $1 AND rr.id = m.reaction_role_id AND rr.guild_id = $2`,
            [mappingId, guildId]
        );
        return result.rowCount > 0;
    } catch (err) {
        console.error('Ошибка удаления маппинга:', err.message);
        throw err;
    }
}

async function updateMapping(guildId, mappingId, emoji, roleId, label) {
    try {
        const result = await db.query(
            `UPDATE reaction_role_mappings m
             SET emoji = $3, role_id = $4, label = $5
             FROM reaction_roles rr
             WHERE m.id = $1 AND rr.id = m.reaction_role_id AND rr.guild_id = $2
             RETURNING m.*`,
            [mappingId, guildId, emoji, roleId, label]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка обновления маппинга:', err.message);
        throw err;
    }
}

async function updateMessageInfo(guildId, id, channelId, messageId) {
    try {
        const result = await db.query(
            `UPDATE reaction_roles SET channel_id = $3, message_id = $4
             WHERE id = $1 AND guild_id = $2 RETURNING *`,
            [id, guildId, channelId, messageId]
        );
        return result.rows[0];
    } catch (err) {
        console.error('Ошибка обновления информации о сообщении:', err.message);
        throw err;
    }
}

module.exports = {
    getReactionRoles, getReactionRoleById, getReactionRoleByMessage,
    createReactionRole, updateReactionRole, deleteReactionRole,
    addMapping, deleteMapping, updateMapping, updateMessageInfo
};
