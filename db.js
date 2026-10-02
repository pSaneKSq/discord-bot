const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const setupStatements = [
    { label: 'warnings', sql: `
        CREATE TABLE IF NOT EXISTS warnings (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            moderator_id VARCHAR(30) NOT NULL,
            reason TEXT DEFAULT 'Не указана',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'warnings.expires_at (alter)', sql: `
        ALTER TABLE warnings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
    `},
    { label: 'warnings index', sql: `
        CREATE INDEX IF NOT EXISTS idx_warnings_guild_user ON warnings (guild_id, user_id);
    `},
    { label: 'user_stats', sql: `
        CREATE TABLE IF NOT EXISTS user_stats (
            guild_id VARCHAR(30) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            messages_count INT DEFAULT 0,
            voice_seconds INT DEFAULT 0,
            first_joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, user_id)
        );
    `},
    { label: 'user_stats.first_joined_at (alter)', sql: `
        ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS first_joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `},
    { label: 'tickets', sql: `
        CREATE TABLE IF NOT EXISTS tickets (
            id SERIAL PRIMARY KEY,
            ticket_number INT NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            channel_id VARCHAR(30) NOT NULL,
            status VARCHAR(20) DEFAULT 'open',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'tickets.closed_at (alter)', sql: `
        ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;
    `},
    { label: 'ticket_logs', sql: `
        CREATE TABLE IF NOT EXISTS ticket_logs (
            id SERIAL PRIMARY KEY,
            ticket_number INT NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            channel_name VARCHAR(100),
            moderator_id VARCHAR(30),
            reason TEXT DEFAULT 'Не указана',
            opened_at TIMESTAMP,
            closed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'ticket_logs index', sql: `
        CREATE INDEX IF NOT EXISTS idx_ticket_logs_closed_at ON ticket_logs (closed_at);
    `},
    { label: 'message_events', sql: `
        CREATE TABLE IF NOT EXISTS message_events (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            channel_id VARCHAR(30) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'message_events index', sql: `
        CREATE INDEX IF NOT EXISTS idx_message_events_guild_time ON message_events (guild_id, created_at);
    `},
    { label: 'voice_sessions', sql: `
        CREATE TABLE IF NOT EXISTS voice_sessions (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            channel_id VARCHAR(30) NOT NULL,
            started_at TIMESTAMP NOT NULL,
            ended_at TIMESTAMP,
            duration_seconds INT DEFAULT 0
        );
    `},
    { label: 'voice_sessions index', sql: `
        CREATE INDEX IF NOT EXISTS idx_voice_sessions_guild_time ON voice_sessions (guild_id, started_at);
    `},
    { label: 'member_events', sql: `
        CREATE TABLE IF NOT EXISTS member_events (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            event_type VARCHAR(10) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'member_events index', sql: `
        CREATE INDEX IF NOT EXISTS idx_member_events_guild_time ON member_events (guild_id, created_at);
    `},
    { label: 'presence_snapshots', sql: `
        CREATE TABLE IF NOT EXISTS presence_snapshots (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            online_count INT DEFAULT 0,
            idle_count INT DEFAULT 0,
            dnd_count INT DEFAULT 0,
            offline_count INT DEFAULT 0,
            captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'presence_snapshots index', sql: `
        CREATE INDEX IF NOT EXISTS idx_presence_snapshots_guild_time ON presence_snapshots (guild_id, captured_at);
    `},
    { label: 'form_cooldowns', sql: `
        CREATE TABLE IF NOT EXISTS form_cooldowns (
            form_id VARCHAR(50) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            cooldown_until TIMESTAMP NOT NULL,
            PRIMARY KEY (form_id, user_id)
        );
    `},
    { label: 'form_applications', sql: `
        CREATE TABLE IF NOT EXISTS form_applications (
            id SERIAL PRIMARY KEY,
            form_id VARCHAR(50) NOT NULL,
            form_title VARCHAR(255),
            user_id VARCHAR(30) NOT NULL,
            answers JSONB DEFAULT '[]',
            status VARCHAR(20) DEFAULT 'pending',
            decided_by VARCHAR(30),
            invited_by VARCHAR(30),
            invited_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            decided_at TIMESTAMP
        );
    `},
    { label: 'form_applications index', sql: `
        CREATE INDEX IF NOT EXISTS idx_form_applications_created ON form_applications (created_at DESC);
    `},
    { label: 'form_applications.claimed_by (alter)', sql: `
        ALTER TABLE form_applications ADD COLUMN IF NOT EXISTS claimed_by VARCHAR(30);
    `},
    { label: 'form_applications.claimed_at (alter)', sql: `
        ALTER TABLE form_applications ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP;
    `},
    // Заметки модераторов. Одна таблица на две задачи:
    // комментарии к заявке (application_id заполнен) и заметки в досье участника (application_id пустой).
    { label: 'member_notes', sql: `
        CREATE TABLE IF NOT EXISTS member_notes (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            author_id VARCHAR(30),
            author_name VARCHAR(100),
            application_id INT,
            text TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'member_notes index (участник)', sql: `
        CREATE INDEX IF NOT EXISTS idx_member_notes_user ON member_notes (guild_id, user_id, created_at DESC);
    `},
    { label: 'member_notes index (заявка)', sql: `
        CREATE INDEX IF NOT EXISTS idx_member_notes_application ON member_notes (application_id);
    `},
    // Накопительные счётчики для топа «за всё время» (message_events / voice_sessions чистятся через 90 дней)
    { label: 'activity_totals', sql: `
        CREATE TABLE IF NOT EXISTS activity_totals (
            guild_id VARCHAR(30) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            messages_count INT NOT NULL DEFAULT 0,
            voice_seconds BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (guild_id, user_id)
        );
    `},
    { label: 'mod_logs', sql: `
        CREATE TABLE IF NOT EXISTS mod_logs (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'mod_logs.message (alter)', sql: `
        ALTER TABLE mod_logs ADD COLUMN IF NOT EXISTS message TEXT NOT NULL DEFAULT '';
    `},
    { label: 'mod_logs.event_type (alter)', sql: `
        ALTER TABLE mod_logs ADD COLUMN IF NOT EXISTS event_type VARCHAR(30) NOT NULL DEFAULT 'other';
    `},
    { label: 'mod_logs — снять обязательность со старых колонок (если есть)', sql: `
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'mod_logs' AND column_name = 'target_id') THEN
                ALTER TABLE mod_logs ALTER COLUMN target_id DROP NOT NULL;
            END IF;
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'mod_logs' AND column_name = 'moderator_id') THEN
                ALTER TABLE mod_logs ALTER COLUMN moderator_id DROP NOT NULL;
            END IF;
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'mod_logs' AND column_name = 'action') THEN
                ALTER TABLE mod_logs ALTER COLUMN action DROP NOT NULL;
            END IF;
        END $$;
    `},
    { label: 'mod_logs index', sql: `
        CREATE INDEX IF NOT EXISTS idx_mod_logs_guild_time ON mod_logs (guild_id, created_at DESC);
    `},
    // Предложения опросов от участников (история; основное хранилище — data/pollSettings.json)
    { label: 'poll_suggestions', sql: `
        CREATE TABLE IF NOT EXISTS poll_suggestions (
            id VARCHAR(50) PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            author_id VARCHAR(30) NOT NULL,
            author_name VARCHAR(100),
            question TEXT NOT NULL,
            options JSONB NOT NULL DEFAULT '[]',
            status VARCHAR(20) DEFAULT 'pending',
            rejection_reason TEXT,
            decided_by VARCHAR(30),
            published_channel_id VARCHAR(30),
            published_message_id VARCHAR(30),
            review_message_id VARCHAR(30),
            review_message_channel_id VARCHAR(30),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            decided_at TIMESTAMP
        );
    `},
    { label: 'poll_suggestions index', sql: `
        CREATE INDEX IF NOT EXISTS idx_poll_suggestions_guild_status ON poll_suggestions (guild_id, status, created_at DESC);
    `},
    // Автороли (Reaction Roles)
    { label: 'reaction_roles', sql: `
        CREATE TABLE IF NOT EXISTS reaction_roles (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            channel_id VARCHAR(30),
            message_id VARCHAR(30),
            title VARCHAR(255) NOT NULL,
            description TEXT,
            color VARCHAR(7) DEFAULT '#5865F2',
            image TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'reaction_roles.image (alter)', sql: `
        ALTER TABLE reaction_roles ADD COLUMN IF NOT EXISTS image TEXT;
    `},
    { label: 'reaction_roles.channel_id nullable (alter)', sql: `
        ALTER TABLE reaction_roles ALTER COLUMN channel_id DROP NOT NULL;
    `},
    { label: 'reaction_roles.message_id nullable (alter)', sql: `
        ALTER TABLE reaction_roles ALTER COLUMN message_id DROP NOT NULL;
    `},
    { label: 'reaction_roles drop unique constraint (alter)', sql: `
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reaction_roles_channel_id_message_id_key') THEN
                ALTER TABLE reaction_roles DROP CONSTRAINT reaction_roles_channel_id_message_id_key;
            END IF;
        END $$;
    `},
    { label: 'reaction_role_mappings', sql: `
        CREATE TABLE IF NOT EXISTS reaction_role_mappings (
            id SERIAL PRIMARY KEY,
            reaction_role_id INT NOT NULL REFERENCES reaction_roles(id) ON DELETE CASCADE,
            emoji VARCHAR(100) NOT NULL,
            role_id VARCHAR(30) NOT NULL,
            label VARCHAR(100),
            UNIQUE(reaction_role_id, emoji)
        );
    `},
    { label: 'reaction_roles index', sql: `
        CREATE INDEX IF NOT EXISTS idx_reaction_roles_guild ON reaction_roles (guild_id);
    `},
    { label: 'reaction_role_mappings index', sql: `
        CREATE INDEX IF NOT EXISTS idx_reaction_role_mappings_role ON reaction_role_mappings (reaction_role_id);
    `},
    // Система уровней и XP
    { label: 'user_levels', sql: `
        CREATE TABLE IF NOT EXISTS user_levels (
            user_id VARCHAR(30) NOT NULL,
            guild_id VARCHAR(30) NOT NULL,
            xp BIGINT DEFAULT 0,
            level INT DEFAULT 1,
            total_messages INT DEFAULT 0,
            last_xp_at TIMESTAMP,
            level_up_count INT DEFAULT 0,
            PRIMARY KEY (user_id, guild_id)
        );
    `},
    { label: 'user_levels index', sql: `
        CREATE INDEX IF NOT EXISTS idx_user_levels_guild_xp ON user_levels (guild_id, xp DESC);
    `},
    { label: 'level_rewards', sql: `
        CREATE TABLE IF NOT EXISTS level_rewards (
            level INT PRIMARY KEY,
            role_id VARCHAR(30) NOT NULL,
            remove_previous BOOLEAN DEFAULT false
        );
    `},
    { label: 'level_rewards.guild_id (alter)', sql: `
        ALTER TABLE level_rewards ADD COLUMN IF NOT EXISTS guild_id VARCHAR(30) NOT NULL DEFAULT '';
    `},
    { label: 'level_rewards drop old PK (alter)', sql: `
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'level_rewards_pkey') THEN
                ALTER TABLE level_rewards DROP CONSTRAINT level_rewards_pkey;
            END IF;
        END $$;
    `},
    { label: 'level_rewards add composite PK (alter)', sql: `
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'level_rewards_pkey') THEN
                ALTER TABLE level_rewards ADD PRIMARY KEY (guild_id, level);
            END IF;
        END $$;
    `},
    { label: 'level_settings', sql: `
        CREATE TABLE IF NOT EXISTS level_settings (
            guild_id VARCHAR(30) PRIMARY KEY,
            enabled BOOLEAN DEFAULT true,
            xp_per_message_min INT DEFAULT 15,
            xp_per_message_max INT DEFAULT 25,
            xp_cooldown_seconds INT DEFAULT 60,
            level_up_channel_id VARCHAR(30),
            level_up_message TEXT DEFAULT '🎉 Поздравляем {user} с достижением уровня {level}!',
            level_up_mode VARCHAR(20) DEFAULT 'current',
            no_xp_roles TEXT[] DEFAULT '{}',
            no_xp_channels TEXT[] DEFAULT '{}'
        );
    `},
    // Система защиты сервера
    { label: 'security_settings', sql: `
        CREATE TABLE IF NOT EXISTS security_settings (
            guild_id VARCHAR(30) PRIMARY KEY,
            enabled BOOLEAN DEFAULT true,
            notification_channel_id VARCHAR(30),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'security_restrictions', sql: `
        CREATE TABLE IF NOT EXISTS security_restrictions (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            user_name VARCHAR(100),
            restriction_type VARCHAR(50) NOT NULL,
            restriction_method VARCHAR(20) DEFAULT 'block',
            notification_enabled BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(guild_id, user_id, restriction_type)
        );
    `},
    { label: 'security_restrictions index', sql: `
        CREATE INDEX IF NOT EXISTS idx_security_restrictions_guild_user ON security_restrictions (guild_id, user_id);
    `},
    { label: 'security_whitelist', sql: `
        CREATE TABLE IF NOT EXISTS security_whitelist (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            user_name VARCHAR(100),
            is_permanent BOOLEAN DEFAULT true,
            added_by VARCHAR(30),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(guild_id, user_id)
        );
    `},
    { label: 'security_whitelist index', sql: `
        CREATE INDEX IF NOT EXISTS idx_security_whitelist_guild_user ON security_whitelist (guild_id, user_id);
    `},
    { label: 'security_logs', sql: `
        CREATE TABLE IF NOT EXISTS security_logs (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            user_name VARCHAR(100),
            action_type VARCHAR(50) NOT NULL,
            restriction_type VARCHAR(50),
            result VARCHAR(20) NOT NULL,
            details TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'security_logs index', sql: `
        CREATE INDEX IF NOT EXISTS idx_security_logs_guild_time ON security_logs (guild_id, created_at DESC);
    `},
    { label: 'security_backups', sql: `
        CREATE TABLE IF NOT EXISTS security_backups (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            backup_type VARCHAR(20) NOT NULL,
            backup_data JSONB NOT NULL,
            created_by VARCHAR(30),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'security_backups index', sql: `
        CREATE INDEX IF NOT EXISTS idx_security_backups_guild_time ON security_backups (guild_id, created_at DESC);
    `},
    { label: 'security_votes', sql: `
        CREATE TABLE IF NOT EXISTS security_votes (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            vote_id VARCHAR(50) NOT NULL,
            action_type VARCHAR(50) NOT NULL,
            target_user_id VARCHAR(30) NOT NULL,
            target_user_name VARCHAR(100),
            executor_user_id VARCHAR(30) NOT NULL,
            executor_user_name VARCHAR(100),
            details TEXT,
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP,
            decided_at TIMESTAMP,
            decision VARCHAR(20),
            UNIQUE(vote_id)
        );
    `},
    { label: 'security_votes index', sql: `
        CREATE INDEX IF NOT EXISTS idx_security_votes_guild_status ON security_votes (guild_id, status, created_at DESC);
    `},
    { label: 'security_vote_responses', sql: `
        CREATE TABLE IF NOT EXISTS security_vote_responses (
            id SERIAL PRIMARY KEY,
            vote_id VARCHAR(50) NOT NULL,
            voter_id VARCHAR(30) NOT NULL,
            voter_name VARCHAR(100),
            vote VARCHAR(10) NOT NULL,
            voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(vote_id, voter_id)
        );
    `},
    { label: 'security_vote_responses index', sql: `
        CREATE INDEX IF NOT EXISTS idx_security_vote_responses_vote ON security_vote_responses (vote_id);
    `},
    // Система отслеживания матов
    { label: 'swear_words', sql: `
        CREATE TABLE IF NOT EXISTS swear_words (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            word VARCHAR(100) NOT NULL,
            added_by VARCHAR(30),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(guild_id, word)
        );
    `},
    { label: 'swear_words index', sql: `
        CREATE INDEX IF NOT EXISTS idx_swear_words_guild ON swear_words (guild_id);
    `},
    { label: 'swear_events', sql: `
        CREATE TABLE IF NOT EXISTS swear_events (
            id SERIAL PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            user_id VARCHAR(30) NOT NULL,
            channel_id VARCHAR(30) NOT NULL,
            word VARCHAR(100) NOT NULL,
            message_id VARCHAR(30),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `},
    { label: 'swear_events index', sql: `
        CREATE INDEX IF NOT EXISTS idx_swear_events_guild_time ON swear_events (guild_id, created_at DESC);
    `},
    { label: 'swear_events user index', sql: `
        CREATE INDEX IF NOT EXISTS idx_swear_events_user ON swear_events (guild_id, user_id, created_at DESC);
    `}
];

async function testConnection() {
    try {
        await pool.query('SELECT NOW()');
        console.log('✅ База данных PostgreSQL успешно подключена!');
    } catch (err) {
        console.error('❌ Не удалось подключиться к базе данных:', err.message);
        return false;
    }

    let hasErrors = false;
    for (const statement of setupStatements) {
        try {
            await pool.query(statement.sql);
        } catch (err) {
            hasErrors = true;
            console.error(`❌ Ошибка выполнения "${statement.label}":`, err.message);
        }
    }

    if (hasErrors) {
        console.warn('⚠️ Часть таблиц/индексов не удалось создать. Смотри ошибки выше.');
    } else {
        console.log('📊 Таблицы базы данных проверены/созданы успешно.');
    }

    return !hasErrors;
}

module.exports = {
    query: (text, params) => pool.query(text, params),
    testConnection
};