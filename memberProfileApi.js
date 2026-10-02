// API вкладки «Досье участника» (Аналитика).
// Собирает в один ответ данные из разных таблиц: варны, заявки, активность,
// входы/выходы, заметки модераторов и упоминания в журнале.
// Подключается из server.js ПОСЛЕ requireAuth: require('./memberProfileApi.js')(app, { ... }).
//
// Новых таблиц не создаёт: заметки лежат в уже существующей member_notes
// (application_id пустой = заметка в досье, заполнен = комментарий к заявке).

const db = require('./db.js');

const ID_RE = /^\d{15,25}$/;
const DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

module.exports = function registerMemberProfileApi(app, { client, isOwnerSession, currentUserName }) {

    function getGuild() {
        if (!client || !client.isReady()) return null;
        return client.guilds.cache.get(process.env.GUILD_ID) || null;
    }

    function toIso(value) {
        if (!value) return null;
        const d = value instanceof Date ? value : new Date(value);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }

    // Тот же принцип, что и на вкладке «Предупреждения»:
    // нет expires_at — бессрочный, expires_at в будущем — действует, иначе истёк.
    function warnState(w) {
        if (!w.expires_at) return 'permanent';
        return new Date(w.expires_at) > new Date() ? 'active' : 'expired';
    }

    function memberToItem(m) {
        return {
            id: m.id,
            username: m.user.username,
            displayName: m.displayName,
            avatar: m.user.displayAvatarURL({ size: 64 }),
            bot: !!m.user.bot,
            inServer: true
        };
    }

    // Превращает набор ID в { id: { username, avatar } } — чтобы фронтенду не делать десятки запросов
    async function resolveUsers(ids) {
        const map = {};
        const unique = [...new Set(ids.filter(id => id && ID_RE.test(String(id))))].slice(0, 60);
        await Promise.all(unique.map(async (id) => {
            const user = await client.users.fetch(id).catch(() => null);
            map[id] = user
                ? { username: user.username, avatar: user.displayAvatarURL({ size: 64 }) }
                : { username: id, avatar: DEFAULT_AVATAR };
        }));
        return map;
    }

    // ==========================================
    // Поиск участника по нику или ID
    // ==========================================
    app.get('/api/members/search', async (req, res) => {
        try {
            if (!client || !client.isReady()) {
                return res.status(503).json({ error: 'Discord бот ещё не готов' });
            }

            const raw = String(req.query.q || '').trim().replace(/^@/, '').slice(0, 64);
            if (raw.length < 2) return res.json([]);

            const guild = getGuild();
            const lower = raw.toLowerCase();
            const found = new Map();

            // 1. Поиск по кэшу участников сервера (ник, отображаемое имя, часть ID)
            if (guild) {
                guild.members.cache.forEach((m) => {
                    if (found.size >= 40) return;
                    const names = [m.user.username, m.user.globalName, m.nickname, m.displayName]
                        .filter(Boolean)
                        .map(s => String(s).toLowerCase());
                    if (m.id.includes(raw) || names.some(s => s.includes(lower))) {
                        found.set(m.id, memberToItem(m));
                    }
                });
            }

            // 2. Точный ID: найдём даже того, кто уже покинул сервер
            if (/^\d{17,20}$/.test(raw) && !found.has(raw)) {
                const member = guild ? await guild.members.fetch(raw).catch(() => null) : null;
                if (member) {
                    found.set(raw, memberToItem(member));
                } else {
                    const user = await client.users.fetch(raw).catch(() => null);
                    if (user) {
                        found.set(raw, {
                            id: user.id,
                            username: user.username,
                            displayName: user.globalName || user.username,
                            avatar: user.displayAvatarURL({ size: 64 }),
                            bot: !!user.bot,
                            inServer: false
                        });
                    }
                }
            }

            // 3. Кэш ничего не дал — спрашиваем Discord напрямую (ищет по началу ника)
            if (guild && found.size === 0 && !/^\d+$/.test(raw)) {
                const members = await guild.members.search({ query: raw, limit: 10 }).catch(() => null);
                if (members) members.forEach(m => found.set(m.id, memberToItem(m)));
            }

            const list = [...found.values()]
                .sort((a, b) => {
                    const as = a.username.toLowerCase().startsWith(lower) ? 0 : 1;
                    const bs = b.username.toLowerCase().startsWith(lower) ? 0 : 1;
                    return as - bs || a.username.localeCompare(b.username);
                })
                .slice(0, 8);

            res.json(list);
        } catch (error) {
            console.error('[Досье] Ошибка поиска участника:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ==========================================
    // Полное досье участника
    // ==========================================
    app.get('/api/members/:userId/profile', async (req, res) => {
        try {
            const userId = String(req.params.userId || '');
            if (!ID_RE.test(userId)) {
                return res.status(400).json({ error: 'Некорректный ID пользователя' });
            }
            if (!client || !client.isReady()) {
                return res.status(503).json({ error: 'Discord бот ещё не готов' });
            }

            const guildId = process.env.GUILD_ID;
            const guild = getGuild();
            const owner = isOwnerSession(req);
            const sessionUserId = (req.session.discordUser && req.session.discordUser.id) || null;

            // Ошибка в одной секции (например, из-за старой схемы таблицы) не должна ронять всё досье
            const errors = {};
            async function safe(name, fn, fallback) {
                try {
                    return await fn();
                } catch (err) {
                    console.error(`[Досье] Ошибка секции "${name}":`, err.message);
                    errors[name] = err.message;
                    return fallback;
                }
            }

            const [user, member] = await Promise.all([
                client.users.fetch(userId).catch(() => null),
                guild ? guild.members.fetch(userId).catch(() => null) : null
            ]);

            const [warnRows, appRows, noteRows, eventRows, statsRow, msgAgg, voiceAgg, dailyRows, topChRows, logRows, levelRow, swearStats] = await Promise.all([
                safe('варны', async () => (await db.query(
                    `SELECT id, reason, moderator_id, created_at, expires_at
                     FROM warnings WHERE guild_id = $1 AND user_id = $2
                     ORDER BY created_at DESC LIMIT 100`, [guildId, userId])).rows, []),

                safe('заявки', async () => (await db.query(
                    `SELECT id, form_id, form_title, status, decided_by, claimed_by, created_at, decided_at
                     FROM form_applications WHERE user_id = $1
                     ORDER BY created_at DESC LIMIT 50`, [userId])).rows, []),

                safe('заметки', async () => (await db.query(
                    `SELECT id, application_id, author_id, author_name, text, created_at
                     FROM member_notes WHERE guild_id = $1 AND user_id = $2
                     ORDER BY created_at DESC, id DESC LIMIT 300`, [guildId, userId])).rows, []),

                safe('входы и выходы', async () => (await db.query(
                    `SELECT event_type, created_at FROM member_events
                     WHERE guild_id = $1 AND user_id = $2
                     ORDER BY created_at DESC LIMIT 200`, [guildId, userId])).rows, []),

                safe('первый вход', async () => (await db.query(
                    `SELECT first_joined_at FROM user_stats WHERE guild_id = $1 AND user_id = $2`,
                    [guildId, userId])).rows[0] || null, null),

                safe('сообщения', async () => (await db.query(
                    `SELECT
                        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int  AS d7,
                        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS d30,
                        COUNT(*)::int AS d90,
                        MAX(created_at) AS last
                     FROM message_events WHERE guild_id = $1 AND user_id = $2`,
                    [guildId, userId])).rows[0], null),

                safe('войс', async () => (await db.query(
                    `SELECT
                        COALESCE(SUM(duration_seconds) FILTER (WHERE started_at >= NOW() - INTERVAL '7 days'), 0)::int  AS s7,
                        COALESCE(SUM(duration_seconds) FILTER (WHERE started_at >= NOW() - INTERVAL '30 days'), 0)::int AS s30,
                        COALESCE(SUM(duration_seconds), 0)::int AS s90,
                        COUNT(*)::int AS sessions,
                        MAX(started_at) AS last
                     FROM voice_sessions WHERE guild_id = $1 AND user_id = $2`,
                    [guildId, userId])).rows[0], null),

                safe('график активности', async () => (await db.query(
                    `WITH bounds AS (SELECT date_trunc('day', LOCALTIMESTAMP) AS today)
                     SELECT to_char(g.d, 'YYYY-MM-DD') AS day, COALESCE(c.cnt, 0)::int AS count
                     FROM bounds, generate_series(bounds.today - INTERVAL '29 days', bounds.today, INTERVAL '1 day') AS g(d)
                     LEFT JOIN (
                        SELECT date_trunc('day', created_at) AS day, COUNT(*) AS cnt
                        FROM message_events
                        WHERE guild_id = $1 AND user_id = $2
                          AND created_at >= (SELECT today FROM bounds) - INTERVAL '29 days'
                        GROUP BY 1
                     ) c ON c.day = g.d
                     ORDER BY g.d`, [guildId, userId])).rows, []),

                safe('топ каналов', async () => (await db.query(
                    `SELECT channel_id, COUNT(*)::int AS value
                     FROM message_events
                     WHERE guild_id = $1 AND user_id = $2 AND created_at >= NOW() - INTERVAL '30 days'
                     GROUP BY channel_id ORDER BY value DESC LIMIT 5`, [guildId, userId])).rows, []),

                safe('журнал', async () => (await db.query(
                    `SELECT id, event_type, message, created_at
                     FROM mod_logs WHERE guild_id = $1 AND message LIKE $2
                     ORDER BY created_at DESC LIMIT 15`, [guildId, `%${userId}%`])).rows, []),

                safe('уровень', async () => (await db.query(
                    `SELECT xp, level, total_messages, level_up_count, last_xp_at
                     FROM user_levels WHERE guild_id = $1 AND user_id = $2`,
                    [guildId, userId])).rows[0] || null, null),

                safe('маты', async () => (await db.query(
                    `SELECT COUNT(*)::int AS count, COUNT(DISTINCT word)::int AS unique_words
                     FROM swear_events WHERE guild_id = $1 AND user_id = $2
                     AND created_at >= NOW() - INTERVAL '30 days'`,
                    [guildId, userId])).rows[0] || { count: 0, unique_words: 0 }, { count: 0, unique_words: 0 })
            ]);

            // ---- Пользователь и участник сервера ----
            const realUser = user || (member && member.user) || null;
            const userInfo = realUser ? {
                id: userId,
                username: realUser.username,
                globalName: realUser.globalName || '',
                avatar: realUser.displayAvatarURL({ size: 256 }),
                bot: !!realUser.bot,
                createdAt: toIso(realUser.createdAt),
                found: true
            } : {
                id: userId,
                username: 'Неизвестный пользователь',
                globalName: '',
                avatar: DEFAULT_AVATAR,
                bot: false,
                createdAt: null,
                found: false
            };

            const memberInfo = member ? {
                displayName: member.displayName,
                nickname: member.nickname || '',
                joinedAt: toIso(member.joinedAt),
                timeoutUntil: (member.communicationDisabledUntil && member.communicationDisabledUntil > new Date())
                    ? toIso(member.communicationDisabledUntil) : null,
                roles: member.roles.cache
                    .filter(r => r.id !== guild.id)
                    .sort((a, b) => b.position - a.position)
                    .map(r => ({ id: r.id, name: r.name, color: r.hexColor }))
            } : null;

            // ---- Варны ----
            const warnItems = warnRows.map(w => ({
                id: w.id,
                reason: w.reason || 'Не указана',
                moderatorId: w.moderator_id,
                createdAt: toIso(w.created_at),
                expiresAt: toIso(w.expires_at),
                state: warnState(w)
            }));
            const warnings = {
                total: warnItems.length,
                active: warnItems.filter(w => w.state !== 'expired').length,
                items: warnItems
            };

            // ---- Заметки: в досье и комментарии к заявкам ----
            const profileNotes = [];
            const notesByApplication = {};
            noteRows.forEach((n) => {
                const item = {
                    id: n.id,
                    authorId: n.author_id,
                    authorName: n.author_name || 'Модератор',
                    text: n.text,
                    createdAt: toIso(n.created_at)
                };
                if (n.application_id === null || n.application_id === undefined) {
                    item.canDelete = owner || (!!sessionUserId && n.author_id === sessionUserId);
                    profileNotes.push(item);
                } else {
                    (notesByApplication[n.application_id] = notesByApplication[n.application_id] || []).push(item);
                }
            });

            // ---- Заявки ----
            const applications = appRows.map(a => ({
                id: a.id,
                formTitle: a.form_title || a.form_id,
                status: a.status,
                decidedBy: a.decided_by,
                claimedBy: a.claimed_by,
                createdAt: toIso(a.created_at),
                decidedAt: toIso(a.decided_at),
                notes: (notesByApplication[a.id] || []).slice().reverse() // старые сверху
            }));

            // ---- Входы / выходы ----
            const joinsCount = eventRows.filter(e => e.event_type === 'join').length;
            const leavesCount = eventRows.filter(e => e.event_type === 'leave').length;
            const membership = {
                firstSeen: statsRow ? toIso(statsRow.first_joined_at) : null,
                joins: joinsCount,
                leaves: leavesCount,
                history: eventRows.slice(0, 10).map(e => ({ type: e.event_type, at: toIso(e.created_at) }))
            };

            // ---- Активность (данные хранятся не дольше 90 дней) ----
            const activity = {
                messages: msgAgg ? {
                    d7: msgAgg.d7, d30: msgAgg.d30, d90: msgAgg.d90, last: toIso(msgAgg.last)
                } : null,
                voice: voiceAgg ? {
                    s7: voiceAgg.s7, s30: voiceAgg.s30, s90: voiceAgg.s90,
                    sessions: voiceAgg.sessions, last: toIso(voiceAgg.last)
                } : null,
                daily: dailyRows,
                topChannels: topChRows.map((row) => {
                    const channel = guild ? guild.channels.cache.get(row.channel_id) : null;
                    return { channelId: row.channel_id, name: channel ? channel.name : 'удалённый канал', value: row.value };
                })
            };

            // ---- Журнал: события, где упоминается этот участник ----
            const logs = logRows.map(l => ({
                id: l.id,
                eventType: l.event_type,
                message: String(l.message || '').slice(0, 600),
                createdAt: toIso(l.created_at)
            }));

            // ---- Уровень и XP ----
            const levelsStore = require('./levelsStore.js');
            let levelInfo = null;
            if (levelRow) {
                const xp = parseInt(levelRow.xp) || 0;
                const level = parseInt(levelRow.level) || 0;
                const progress = levelsStore.calculateLevelProgress(xp, level);

                levelInfo = {
                    xp: xp,
                    level: level,
                    totalMessages: parseInt(levelRow.total_messages) || 0,
                    levelUpCount: parseInt(levelRow.level_up_count) || 0,
                    lastXpAt: toIso(levelRow.last_xp_at),
                    progress: {
                        current: progress.current,
                        needed: progress.needed,
                        percentage: progress.percentage,
                        toNextLevel: progress.toNextLevel
                    }
                };
            }

            // ---- Статистика матов ----
            const swears = {
                count: swearStats.count || 0,
                uniqueWords: swearStats.unique_words || 0
            };

            // ---- Имена и аватарки всех, кто встречается в досье ----
            const idsToResolve = [];
            warnItems.forEach(w => idsToResolve.push(w.moderatorId));
            applications.forEach(a => { idsToResolve.push(a.decidedBy, a.claimedBy); a.notes.forEach(n => idsToResolve.push(n.authorId)); });
            profileNotes.forEach(n => idsToResolve.push(n.authorId));
            logs.forEach((l) => {
                for (const m of l.message.matchAll(/<@!?(\d+)>/g)) idsToResolve.push(m[1]);
            });
            const users = await resolveUsers(idsToResolve);

            res.json({
                user: userInfo,
                member: memberInfo,
                membership,
                warnings,
                applications,
                activity,
                notes: profileNotes,
                logs,
                level: levelInfo,
                swears,
                users,
                errors
            });
        } catch (error) {
            console.error('[Досье] Ошибка сборки досье:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ==========================================
    // Заметки модераторов в досье
    // ==========================================
    app.post('/api/members/:userId/notes', async (req, res) => {
        try {
            const userId = String(req.params.userId || '');
            const text = String((req.body && req.body.text) || '').trim();

            if (!ID_RE.test(userId)) return res.status(400).json({ error: 'Некорректный ID пользователя' });
            if (!text) return res.status(400).json({ error: 'Введите текст заметки' });
            if (text.length > 1000) return res.status(400).json({ error: 'Заметка не должна быть длиннее 1000 символов' });

            const authorId = (req.session.discordUser && req.session.discordUser.id) || null;

            const inserted = await db.query(
                `INSERT INTO member_notes (guild_id, user_id, author_id, author_name, text)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, author_id, author_name, text, created_at`,
                [process.env.GUILD_ID, userId, authorId, currentUserName(req), text]
            );

            res.json({ success: true, note: inserted.rows[0] });
        } catch (error) {
            console.error('[Досье] Ошибка добавления заметки:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Удалить заметку из досье: автор заметки или владелец панели.
    // Комментарии к заявкам (application_id заполнен) здесь не удаляются.
    app.post('/api/members/notes/:noteId/delete', async (req, res) => {
        try {
            const noteId = parseInt(req.params.noteId, 10);
            if (!Number.isInteger(noteId)) return res.status(400).json({ error: 'Некорректный ID заметки' });

            const found = await db.query(
                `SELECT id, author_id, application_id FROM member_notes WHERE id = $1 AND guild_id = $2`,
                [noteId, process.env.GUILD_ID]
            );
            const note = found.rows[0];
            if (!note) return res.status(404).json({ error: 'Заметка не найдена' });
            if (note.application_id !== null && note.application_id !== undefined) {
                return res.status(400).json({ error: 'Комментарии к заявкам удалять нельзя' });
            }

            const sessionUserId = (req.session.discordUser && req.session.discordUser.id) || null;
            const allowed = isOwnerSession(req) || (!!sessionUserId && note.author_id === sessionUserId);
            if (!allowed) return res.status(403).json({ error: 'Удалить заметку может только её автор или владелец панели' });

            await db.query(`DELETE FROM member_notes WHERE id = $1`, [noteId]);
            res.json({ success: true });
        } catch (error) {
            console.error('[Досье] Ошибка удаления заметки:', error);
            res.status(500).json({ error: error.message });
        }
    });
};