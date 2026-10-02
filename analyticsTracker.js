// Пишет "сырые" события в базу: сообщения, войс-сессии, входы/выходы участников,
// а также периодически снимает срез статусов (онлайн/afk/dnd/offline).
module.exports = function registerAnalyticsTracking(client, db) {
    // Инициализация модуля уровней
    let levelsModule = null;
    try {
        const levelsModuleFactory = require('./levels.js');
        levelsModule = levelsModuleFactory(client, require('./logger.js').sendLog);
    } catch (err) {
        console.error('Ошибка инициализации модуля уровней:', err.message);
    }
    const activeVoiceSessions = new Map(); // ключ: `${guildId}:${userId}` -> { channelId, startedAt }
    const swearWordsCache = new Map(); // ключ: guildId -> Set слов-матов

    async function closeVoiceSession(guildId, userId, channelId, startedAt) {
        const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
        try {
            await db.query(
                `INSERT INTO voice_sessions (guild_id, user_id, channel_id, started_at, ended_at, duration_seconds)
                 VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), NOW(), $5)`,
                [guildId, userId, channelId, startedAt, durationSeconds]
            );
        } catch (err) {
            console.error('[Analytics] Ошибка записи голосовой сессии:', err.message);
        }
        // Накопительный счётчик для топа «за всё время» (еженедельный отчёт)
        try {
            await db.query(
                `INSERT INTO activity_totals (guild_id, user_id, voice_seconds) VALUES ($1, $2, $3)
                 ON CONFLICT (guild_id, user_id) DO UPDATE SET voice_seconds = activity_totals.voice_seconds + $3`,
                [guildId, userId, durationSeconds]
            );
        } catch (err) {
            console.error('[Analytics] Ошибка обновления счётчика войса:', err.message);
        }
    }

    // Загрузка списка матов при старте
    const swearWordsStore = require('./swearWordsStore.js');

    async function loadSwearWords(guildId) {
        try {
            const words = await swearWordsStore.getSwearWords(guildId);
            swearWordsCache.set(guildId, new Set(words));
            console.log(`[SwearWords] Загружено ${words.length} слов-матов для guild ${guildId}`);
        } catch (err) {
            console.error(`[SwearWords] Ошибка загрузки списка матов для guild ${guildId}:`, err.message);
        }
    }

    client.once('ready', () => {
        // Загружаем маты для всех серверов, на которых находится бот
        client.guilds.cache.forEach(guild => {
            loadSwearWords(guild.id);
        });
        setTimeout(capturePresenceSnapshot, 5000);
    });

    // Периодическое обновление кэша матов (раз в час)
    setInterval(() => {
        client.guilds.cache.forEach(guild => {
            loadSwearWords(guild.id);
        });
    }, 60 * 60 * 1000);

    // Экспортируем функцию для принудительного обновления кэша
    module.exports = {
        loadSwearWords
    };

    // 1. СООБЩЕНИЯ
    client.on('messageCreate', async (message) => {
        if (!message.guild || message.author.bot) return;
        try {
            await db.query(
                'INSERT INTO message_events (guild_id, user_id, channel_id) VALUES ($1, $2, $3)',
                [message.guild.id, message.author.id, message.channel.id]
            );
        } catch (err) {
            console.error('[Analytics] Ошибка записи сообщения:', err.message);
        }
        // Накопительный счётчик для топа «за всё время» (еженедельный отчёт)
        try {
            await db.query(
                `INSERT INTO activity_totals (guild_id, user_id, messages_count) VALUES ($1, $2, 1)
                 ON CONFLICT (guild_id, user_id) DO UPDATE SET messages_count = activity_totals.messages_count + 1`,
                [message.guild.id, message.author.id]
            );
        } catch (err) {
            console.error('[Analytics] Ошибка обновления счётчика сообщений:', err.message);
        }
        
        // Проверка на маты
        const guildSwearWords = swearWordsCache.get(message.guild.id);
        if (guildSwearWords && guildSwearWords.size > 0) {
            const messageLower = message.content.toLowerCase();
            for (const swearWord of guildSwearWords) {
                if (messageLower.includes(swearWord)) {
                    try {
                        await swearWordsStore.recordSwearEvent(
                            message.guild.id,
                            message.author.id,
                            message.channel.id,
                            swearWord,
                            message.id
                        );
                    } catch (err) {
                        console.error('[SwearWords] Ошибка записи события мата:', err.message);
                    }
                    break; // Записываем только один мат на сообщение
                }
            }
        }
        
        // Обработка XP за сообщение
        if (levelsModule && levelsModule.processMessageXp) {
            try {
                await levelsModule.processMessageXp(client, message, require('./logger.js').sendLog);
            } catch (err) {
                console.error('[Levels] Ошибка обработки XP:', err.message);
            }
        }
    });

    // 2. ГОЛОСОВЫЕ КАНАЛЫ
    client.on('voiceStateUpdate', async (oldState, newState) => {
        const guildId = (newState.guild || oldState.guild).id;
        const userId = (newState.member || oldState.member)?.id;
        if (!userId) return;
        const key = `${guildId}:${userId}`;

        // Зашёл в войс
        if (!oldState.channelId && newState.channelId) {
            activeVoiceSessions.set(key, { channelId: newState.channelId, startedAt: Date.now() });
            return;
        }

        // Вышел из войса
        if (oldState.channelId && !newState.channelId) {
            const session = activeVoiceSessions.get(key);
            if (session) {
                activeVoiceSessions.delete(key);
                await closeVoiceSession(guildId, userId, session.channelId, session.startedAt);
            }
            return;
        }

        // Переход между каналами
        if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            const session = activeVoiceSessions.get(key);
            if (session) {
                await closeVoiceSession(guildId, userId, session.channelId, session.startedAt);
            }
            activeVoiceSessions.set(key, { channelId: newState.channelId, startedAt: Date.now() });
        }
    });

    // 3. ВХОД / ВЫХОД УЧАСТНИКОВ (требует Server Members Intent)
    client.on('guildMemberAdd', async (member) => {
        try {
            await db.query(
                'INSERT INTO member_events (guild_id, user_id, event_type) VALUES ($1, $2, $3)',
                [member.guild.id, member.id, 'join']
            );
        } catch (err) {
            console.error('[Analytics] Ошибка записи входа участника:', err.message);
        }
    });

    client.on('guildMemberRemove', async (member) => {
        try {
            await db.query(
                'INSERT INTO member_events (guild_id, user_id, event_type) VALUES ($1, $2, $3)',
                [member.guild.id, member.id, 'leave']
            );
        } catch (err) {
            console.error('[Analytics] Ошибка записи выхода участника:', err.message);
        }
    });

    // 4. СНИМОК СТАТУСОВ (требует Presence Intent)
    async function capturePresenceSnapshot() {
        try {
            // Делаем снимок для всех серверов
            for (const guild of client.guilds.cache.values()) {
                let online = 0, idle = 0, dnd = 0, offline = 0;
                const members = await guild.members.fetch();
                members.forEach(m => {
                    const status = m.presence?.status;
                    if (status === 'online') online++;
                    else if (status === 'idle') idle++;
                    else if (status === 'dnd') dnd++;
                    else offline++;
                });

                await db.query(
                    `INSERT INTO presence_snapshots (guild_id, online_count, idle_count, dnd_count, offline_count)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [guild.id, online, idle, dnd, offline]
                );
            }
        } catch (err) {
            console.error('[Analytics] Ошибка снимка статусов (проверь Presence Intent):', err.message);
        }
    }

    setInterval(capturePresenceSnapshot, 15 * 60 * 1000); // раз в 15 минут

    // 5. АВТООЧИСТКА СТАРЫХ ДАННЫХ (чтобы таблицы не разрастались бесконечно)
    async function cleanupOldEvents() {
        try {
            await db.query(`DELETE FROM message_events WHERE created_at < NOW() - INTERVAL '90 days'`);
            await db.query(`DELETE FROM voice_sessions WHERE started_at < NOW() - INTERVAL '90 days'`);
            await db.query(`DELETE FROM presence_snapshots WHERE captured_at < NOW() - INTERVAL '30 days'`);
        } catch (err) {
            console.error('[Analytics] Ошибка очистки старых данных:', err.message);
        }
    }
    setInterval(cleanupOldEvents, 24 * 60 * 60 * 1000); // раз в сутки
};