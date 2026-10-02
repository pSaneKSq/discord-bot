const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

const { client } = require('./index.js');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Настройка multer для загрузки файлов
const upload = multer({ dest: 'data/temp/' });

// Создаём временную папку для multer
const tempDir = path.join(__dirname, 'data', 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// ==========================================
// АВТОРИЗАЦИЯ ДАШБОРДА
// ==========================================

const FileStore = require('./sessionStore.js');
app.use(session({
    store: new FileStore(path.join(__dirname, 'data', 'sessions')),
    secret: process.env.SESSION_SECRET || 'change_this_secret_in_env',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30, httpOnly: true, sameSite: 'lax' }
}));

function requireAuth(req, res, next) {
    if (req.session && req.session.loggedIn) return next();
    if (req.originalUrl.startsWith('/api')) return res.status(401).json({ error: 'Не авторизован' });
    return res.redirect('/');
}

// Владелец = вход по логину/паролю ИЛИ Discord ID совпадает с OWNER_DISCORD_ID из .env.
// Настройки сайта (стиль + управление белым списком) видны и доступны только владельцу.
function isOwnerSession(req) {
    if (!req.session || !req.session.loggedIn) return false;
    if (!req.session.discordUser) return true; // вход по логину/паролю — это всегда владелец
    const ownerId = process.env.OWNER_DISCORD_ID;
    return !!ownerId && req.session.discordUser.id === ownerId;
}

function requireOwner(req, res, next) {
    if (isOwnerSession(req)) return next();
    return res.status(403).json({ error: 'Доступно только владельцу панели' });
}

// Проверка доступа пользователя к серверу
async function requireGuildAccess(req, res, next) {
    let guildId = (req.session && req.session.guildId) || (req.query && req.query.guild_id) || (req.body && req.body.guild_id) || (req.params && req.params.guildId);

    // Если guild_id не указан, используем defaultGuildId из настроек или GUILD_ID из .env
    if (!guildId) {
        const settings = siteSettings.getSettings();
        guildId = settings.defaultGuildId || process.env.GUILD_ID;
    }

    // Проверяем, что бот есть на этом сервере
    if (client && client.isReady()) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            // Если указанный сервер недоступен, пробуем defaultGuildId или GUILD_ID
            const settings = siteSettings.getSettings();
            guildId = settings.defaultGuildId || process.env.GUILD_ID;
        }
    }

    // Не владелец может работать только с серверами, где у него есть права
    if (req.session && req.session.discordUser && !isOwnerSession(req)) {
        if (!client || !client.isReady()) {
            return res.status(500).json({ error: 'Discord бот еще не готов' });
        }

        try {
            const member = await client.guilds.cache.get(guildId)
                ?.members.fetch(req.session.discordUser.id).catch(() => null);
            if (!member || !member.permissions.has('ManageGuild')) {
                return res.status(403).json({ error: 'Нет доступа к этому серверу' });
            }
        } catch (error) {
            console.error('Ошибка проверки прав доступа:', error.message);
            return res.status(403).json({ error: 'Нет доступа к этому серверу' });
        }
    }

    res.locals.guildId = guildId;
    next();
}

// Выбор сервера для работы в панели
app.post('/api/guild/select', (req, res) => {
    const { guildId } = req.body;
    if (!client || !client.isReady()) {
        return res.status(500).json({ error: 'Discord бот еще не готов' });
    }
    if (!client.guilds.cache.has(guildId)) {
        return res.status(404).json({ error: 'Бот не на этом сервере' });
    }
    req.session.guildId = guildId;
    res.json({ success: true });
});

app.post('/logout', (req, res) => {
    // Уничтожаем сессию и редиректим на главную страницу
    req.session.destroy((err) => {
        if (err) {
            console.error('Ошибка при выходе:', err);
        }
        res.redirect('/');
    });
});

// ==========================================
// ЛЕНДИНГ
// ==========================================

app.get('/', async (req, res) => {
    try {
        const s = req.session || {};
        res.render('landing', {
            clan: await require('./clanSite.js').build(client),
            user: s.user || (s.loggedIn && s.discordUser) || null,
            isPanel: !!s.loggedIn,
            error: String(req.query.error || '').slice(0, 200)
        });
    } catch (err) {
        console.error('Ошибка главной страницы:', err);
        res.status(500).send('Ошибка сервера');
    }
});

// ==========================================
// СТРАНИЦА ПРИГЛАШЕНИЯ БОТА (удалена - используется /servers)
// ==========================================
// ВХОД ЧЕРЕЗ DISCORD (OAuth2) + БЕЛЫЙ СПИСОК ПО ID
// ==========================================

const accessControl = require('./accessControl.js');
const siteSettings = require('./siteSettings.js');

app.get('/auth/discord', (req, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID, redirect = process.env.DISCORD_REDIRECT_URI;
    if (!clientId || !redirect) return res.redirect('/?error=' + encodeURIComponent('Discord-вход не настроен'));
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const url = 'https://discord.com/api/oauth2/authorize?' + new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'identify', state, prompt: 'none'
    });
    req.session.save(() => res.redirect(url));
});

app.get('/auth/discord/callback', async (req, res) => {
    const fail = m => res.redirect('/?error=' + encodeURIComponent(m));
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) return fail('Не удалось войти, попробуйте ещё раз');
    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.DISCORD_REDIRECT_URI
            })
        });
        const token = await tokenRes.json();
        if (!token.access_token) return fail('Не удалось войти через Discord');

        const du = await (await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${token.access_token}` }
        })).json();

        const avatar = du.avatar
            ? `https://cdn.discordapp.com/avatars/${du.id}/${du.avatar}.png`
            : 'https://cdn.discordapp.com/embed/avatars/0.png';
        const panelOk = (!!process.env.OWNER_DISCORD_ID && du.id === process.env.OWNER_DISCORD_ID) || accessControl.isAllowed(du.id);

        req.session.regenerate(err => {
            if (err) return fail('Ошибка сессии');
            req.session.user = { id: du.id, username: du.global_name || du.username, avatar };
            if (panelOk) {
                req.session.loggedIn = true;
                req.session.username = du.username;
                req.session.discordUser = { id: du.id, username: du.username, avatar };
            }
            req.session.save(() => res.redirect('/'));
        });
    } catch (err) {
        console.error('Ошибка авторизации через Discord:', err.message);
        fail('Ошибка при входе через Discord');
    }
});

// Всё, что ниже, требует входа в систему
app.use(['/dashboard', '/forms', '/api'], requireAuth);

// Подключаем API редактора страницы клана
require('./clanApi.js')(app, { client, requireOwner, upload });

// ==========================================
// ХРАНИЛИЩА
// ==========================================

const { createDefaultForm, getFormsStorage } = require('./formsStore.js');
const analyticsStore = require('./analyticsStore.js');
const moderationStore = require('./moderationStore.js');
const automodStore = require('./automodStore.js');
const announcementStore = require('./announcementStore.js');
const announcements = require('./announcements.js');
const weeklyReport = require('./weeklyReport.js');
const weeklyReportStore = require('./weeklyReportStore.js');
const polls = require('./polls.js');
const db = require('./db.js');

// Имя текущего пользователя панели (для записи в журнал)
function currentUserName(req) {
    return (req.session && req.session.discordUser && req.session.discordUser.username)
        || (req.session && req.session.username)
        || 'Admin';
}

// Helper для получения guild_id из запроса
function getGuildId(req, res) {
    return (req.query && req.query.guild_id) || (req.body && req.body.guild_id) || res.locals.guildId || process.env.GUILD_ID;
}

app.use((req, res, next) => {
    // guildId устанавливается через requireGuildAccess middleware или по умолчанию
    if (!res.locals.guildId) {
        res.locals.guildId = process.env.GUILD_ID || '';
    }

    res.locals.currentUser = {
        username: currentUserName(req),
        avatar: (req.session && req.session.discordUser && req.session.discordUser.avatar)
            || 'https://cdn.discordapp.com/embed/avatars/0.png'
    };

    res.locals.isOwner = isOwnerSession(req);
    res.locals.siteSettings = siteSettings.getSettings();

    // Получаем формы для текущего сервера
    const currentFormsStorage = getFormsStorage(res.locals.guildId);
    res.locals.stats = { total: Object.keys(currentFormsStorage).length, published: 0, drafts: 0 };

    res.locals.cards = Object.values(currentFormsStorage).map(form => ({
        id: form.id,
        title: form.embedTitle,
        channelId: form.channelId || '',
        messageId: form.messageId || '',
        questionsCount: (form.questions && form.questions.length) || 0
    }));

    next();
});

// ==========================================
// МАРШРУТЫ СТРАНИЦ
// ==========================================

app.get('/dashboard', requireGuildAccess, (req, res) => {
    const tab = req.query.tab;
    let activeTab = 'tickets/forms';

    if (tab === 'applications') activeTab = 'tickets/applications';
    else if (tab === 'stats') activeTab = 'tickets/stats';
    else if (tab === 'embed') activeTab = 'embed';
    else if (tab === 'forms') activeTab = 'tickets/forms';
    else if (tab === 'editForm') activeTab = 'tickets/editForm';
    else if (tab === 'settings') activeTab = 'ownerSettings';
    else if (tab === 'modLogs') activeTab = 'moderation/logs';
    else if (tab === 'modSettings') activeTab = 'moderation/settings';
    else if (tab === 'warnings') activeTab = 'moderation/warnings';
    else if (tab === 'automod') activeTab = 'moderation/automod';
    else if (tab === 'member') activeTab = 'analytics/member';
    else if (tab === 'weeklyReport') activeTab = 'analytics/weeklyReport';
    else if (tab === 'swearWords') activeTab = 'analytics/swearWords';
    else if (tab === 'polls') activeTab = 'notifications/polls';
    else if (tab === 'reactionRoles') activeTab = 'notifications/reactionRoles';
    else if (tab === 'levels') activeTab = 'notifications/levels';
    else if (tab === 'sounds') activeTab = 'notifications/sounds';
    else if (tab === 'security') activeTab = 'security/restrictions';
    else if (tab === 'securityWhitelist') activeTab = 'security/whitelist';
    else if (tab === 'securityLogs') activeTab = 'security/logs';
    else if (tab === 'securitySettings') activeTab = 'security/settings';
    else if (tab === 'securityBackups') activeTab = 'security/backups';
    else if (tab === 'clan') activeTab = 'ownerClan';

    // Вкладка настроек — только для владельца, даже если кто-то введёт URL руками
    if ((activeTab === 'ownerSettings' || activeTab === 'ownerClan') && !res.locals.isOwner) {
        return res.redirect('/dashboard');
    }

    const formId = req.query.id;
    let form;

    if (activeTab === 'tickets/editForm') {
        if (formId) {
            const currentFormsStorage = getFormsStorage(res.locals.guildId);
            if (!currentFormsStorage[formId]) {
                currentFormsStorage[formId] = createDefaultForm(formId);
            }
            form = currentFormsStorage[formId];
        } else {
            return res.redirect('/forms');
        }
    }

    res.render('dashboard', { activeTab, form, guildId: res.locals.guildId });
});

app.get('/forms', (req, res) => {
    res.render('dashboard', { activeTab: 'tickets/forms', guildId: res.locals.guildId || process.env.GUILD_ID });
});

app.get('/forms/:formId/edit', requireGuildAccess, (req, res) => {
    const formId = req.params.formId;
    const guildId = res.locals.guildId;
    const currentFormsStorage = getFormsStorage(guildId);

    if (!currentFormsStorage[formId]) {
        currentFormsStorage[formId] = createDefaultForm(formId);
    }

    res.render('dashboard', {
        activeTab: 'tickets/editForm',
        form: currentFormsStorage[formId],
        guildId: guildId
    });
});

// ==========================================
// API — Discord (каналы/роли/пользователи)
// ==========================================

app.get('/api/guilds/:guildId/channels', async (req, res) => {
    try {
        if (!client || !client.isReady()) {
            return res.status(500).json({ error: 'Discord бот еще не готов' });
        }
        const guildId = req.params.guildId || res.locals.guildId;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Сервер не найден' });

        const channels = guild.channels.cache
            .filter(c => c.type === 0)
            .map(c => ({ id: c.id, name: c.name }));
        res.json(channels);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/guilds/:guildId/roles', async (req, res) => {
    try {
        if (!client || !client.isReady()) {
            return res.status(500).json({ error: 'Discord бот еще не готов' });
        }
        const guildId = req.params.guildId || res.locals.guildId;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Сервер не найден' });

        const roles = guild.roles.cache
            .filter(r => r.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .map(r => ({ id: r.id, name: r.name, color: r.hexColor }));
        res.json(roles);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/discord/users/:userId', async (req, res) => {
    try {
        if (!client || !client.isReady()) {
            return res.status(500).json({ error: 'Discord бот еще не готов' });
        }
        const user = await client.users.fetch(req.params.userId).catch(() => null);
        if (!user) {
            return res.json({ username: 'Неизвестный пользователь', avatar: 'https://cdn.discordapp.com/embed/avatars/0.png' });
        }
        res.json({ username: user.username, avatar: user.displayAvatarURL({ size: 64 }) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// API — Настройки сайта (только владелец)
// ==========================================

// Текущие настройки стиля + список разрешённых Discord ID (с username/аватарками)
app.get('/api/settings', requireOwner, async (req, res) => {
    try {
        const ids = accessControl.getAllowedIds();

        const enrichedIds = await Promise.all(ids.map(async (id) => {
            let username = id;
            let avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
            if (client && client.isReady()) {
                const user = await client.users.fetch(id).catch(() => null);
                if (user) {
                    username = user.username;
                    avatar = user.displayAvatarURL({ size: 64 });
                }
            }
            return { id, username, avatar };
        }));

        res.json({
            style: siteSettings.getSettings(),
            allowedIds: enrichedIds,
            ownerConfigured: !!process.env.OWNER_DISCORD_ID
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Обновление стиля сайта
app.post('/api/settings/style', requireOwner, (req, res) => {
    try {
        const { accentColor, accentColorSecondary, siteName } = req.body;
        const updated = siteSettings.updateSettings({
            ...(accentColor ? { accentColor } : {}),
            ...(accentColorSecondary ? { accentColorSecondary } : {}),
            ...(siteName ? { siteName } : {})
        });
        res.json({ success: true, style: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Добавить Discord ID в белый список
app.post('/api/settings/access/add', requireOwner, (req, res) => {
    try {
        const { discordId } = req.body;
        if (!discordId || !/^\d{15,25}$/.test(String(discordId).trim())) {
            return res.status(400).json({ error: 'Укажите корректный Discord ID (только цифры)' });
        }
        const added = accessControl.addAllowedId(discordId);
        res.json({ success: true, added });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Убрать Discord ID из белого списка
app.post('/api/settings/access/remove', requireOwner, (req, res) => {
    try {
        const { discordId } = req.body;
        const removed = accessControl.removeAllowedId(discordId);
        res.json({ success: true, removed });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Получить список серверов бота
app.get('/api/guilds', requireOwner, (req, res) => {
    try {
        if (!client || !client.isReady()) {
            return res.status(500).json({ error: 'Discord бот еще не готов' });
        }
        const guilds = client.guilds.cache.map(guild => ({
            id: guild.id,
            name: guild.name,
            icon: guild.icon
        }));
        res.json({ guilds });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Установить сервер по умолчанию
app.post('/api/settings/default-guild', requireOwner, (req, res) => {
    try {
        const { guildId } = req.body;
        if (!guildId) {
            return res.status(400).json({ error: 'Не указан сервер' });
        }
        if (!client || !client.isReady()) {
            return res.status(500).json({ error: 'Discord бот еще не готов' });
        }
        if (!client.guilds.cache.has(guildId)) {
            return res.status(404).json({ error: 'Бот не на этом сервере' });
        }
        const updated = siteSettings.updateSettings({ defaultGuildId: guildId });
        res.json({ success: true, settings: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// API — Формы
// ==========================================

app.post('/api/forms/create', requireGuildAccess, (req, res) => {
    try {
        const guildId = res.locals.guildId;
        const currentFormsStorage = getFormsStorage(guildId);
        const newId = Date.now().toString();
        currentFormsStorage[newId] = createDefaultForm(newId, { embedTitle: 'Новая форма', embedDesc: '' });
        res.json({ success: true, formId: newId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/forms/:formId/delete', requireGuildAccess, (req, res) => {
    try {
        const guildId = res.locals.guildId;
        const formId = req.params.formId;
        const currentFormsStorage = getFormsStorage(guildId);
        if (!currentFormsStorage[formId]) {
            return res.status(404).json({ error: 'Форма не найдена' });
        }
        delete currentFormsStorage[formId];
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/forms/:formId/publish', requireGuildAccess, async (req, res) => {
    try {
        const guildId = res.locals.guildId;
        const formId = req.params.formId;
        const currentFormsStorage = getFormsStorage(guildId);
        const existingForm = currentFormsStorage[formId];

        const channelId = (req.body && req.body.channelId) || (existingForm && existingForm.channelId);

        if (!channelId) {
            return res.status(400).json({ error: 'Сначала укажите и сохраните ID канала в редакторе формы' });
        }

        const channel = await client.channels.fetch(channelId);
        if (!channel) return res.status(404).json({ error: 'Канал не найден' });

        const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
        const formData = existingForm || { embedTitle: 'Подать заявку', buttonText: 'Подать заявку' };

        const embed = new EmbedBuilder()
            .setTitle(formData.embedTitle)
            .setDescription(formData.embedDesc || ' ')
            .setColor(formData.embedColor || '#8b5cf6');

        if (formData.embedAuthor) embed.setAuthor({ name: formData.embedAuthor });
        if (formData.imageUrl && formData.imageUrl.startsWith('http')) {
            embed.setImage(formData.imageUrl);
        }

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`open_form_${formId}`)
                    .setLabel(formData.buttonText || 'Подать заявку')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('📝')
            );

        const sentMessage = await channel.send({
            embeds: [embed],
            components: [row]
        });

        currentFormsStorage[formId] = currentFormsStorage[formId] || createDefaultForm(formId);
        currentFormsStorage[formId].channelId = channelId;
        currentFormsStorage[formId].messageId = sentMessage.id;
        saveForms();

        res.json({ success: true, messageId: sentMessage.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const saveFormHandler = async (req, res) => {
    try {
        const guildId = res.locals.guildId;
        const formId = req.params.formId;
        const currentFormsStorage = getFormsStorage(guildId);
        const existing = currentFormsStorage[formId] || createDefaultForm(formId);

        const {
            channelId,
            messageId,
            title, embedTitle,
            description, embedDescription, embedDesc,
            color, embedColor,
            buttonText,
            author, embedAuthor,
            imageUrl,
            questions,
            settings,
            actions
        } = req.body;

        const finalData = {
            id: formId,
            channelId: channelId || existing.channelId || '',
            messageId: messageId || existing.messageId || '',
            embedTitle: title || embedTitle || 'Заявка',
            embedDesc: description || embedDescription || embedDesc || '',
            embedColor: color || embedColor || '#8b5cf6',
            embedAuthor: author || embedAuthor || '',
            buttonText: buttonText || 'Подать заявку',
            imageUrl: imageUrl || existing.imageUrl || '',
            questions: Array.isArray(questions) ? questions : existing.questions,
            settings: settings && typeof settings === 'object' ? { ...existing.settings, ...settings } : existing.settings,
            actions: actions && typeof actions === 'object' ? {
                accept: { ...existing.actions.accept, ...(actions.accept || {}) },
                reject: { ...existing.actions.reject, ...(actions.reject || {}) }
            } : existing.actions
        };

        currentFormsStorage[formId] = finalData;
        console.log(`[БД] Конфигурация формы ${formId} успешно обновлена для сервера ${guildId}:`, finalData);

        if (finalData.channelId && finalData.messageId && client && client.isReady()) {
            try {
                const channel = await client.channels.fetch(finalData.channelId);
                if (channel) {
                    const message = await channel.messages.fetch(finalData.messageId);
                    if (message) {
                        const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

                        const updatedEmbed = new EmbedBuilder()
                            .setTitle(finalData.embedTitle)
                            .setDescription(finalData.embedDesc || ' ')
                            .setColor(finalData.embedColor);

                        if (finalData.embedAuthor) updatedEmbed.setAuthor({ name: finalData.embedAuthor });
                        if (finalData.imageUrl && finalData.imageUrl.startsWith('http')) {
                            updatedEmbed.setImage(finalData.imageUrl);
                        }

                        const updatedRow = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`open_form_${formId}`)
                                    .setLabel(finalData.buttonText)
                                    .setStyle(ButtonStyle.Primary)
                                    .setEmoji('📝')
                            );

                        await message.edit({
                            embeds: [updatedEmbed],
                            components: [updatedRow]
                        });
                        console.log(`[Discord] Сообщение ${finalData.messageId} автоматически синхронизировано.`);
                    }
                }
            } catch (discordError) {
                console.warn(`[Discord] Не удалось обновить активное сообщение: ${discordError.message}`);
            }
        }

        res.json({ success: true, message: 'Изменения успешно сохранены в базе!' });
    } catch (error) {
        console.error('Ошибка сохранения конфига формы:', error);
        res.status(500).json({ error: error.message });
    }
};

app.post('/api/forms/:formId/update', saveFormHandler);
app.put('/api/forms/:formId/update', saveFormHandler);
app.post('/api/forms/:formId/embed', saveFormHandler);

// ==========================================
// API — История заявок форм-конструктора
// ==========================================

app.get('/api/forms/applications', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const search = req.query.search ? req.query.search.trim() : '';
        const status = req.query.status ? req.query.status.trim() : '';
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

        let query = `SELECT * FROM form_applications`;
        const conditions = [`guild_id = $1`];
        const params = [guildId];

        if (search) {
            params.push(`%${search}%`);
            conditions.push(`(id::text ILIKE $${params.length} OR user_id ILIKE $${params.length} OR form_title ILIKE $${params.length})`);
        }
        if (status && ['pending', 'accepted', 'rejected'].includes(status)) {
            params.push(status);
            conditions.push(`status = $${params.length}`);
        }

        query += ` WHERE ` + conditions.join(' AND ');
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await db.query(query, params);
        const apps = result.rows;

        // Подтягиваем комментарии модераторов ко всем найденным заявкам одним запросом
        if (apps.length) {
            const ids = apps.map(a => a.id);
            const notesRes = await db.query(
                `SELECT id, application_id, author_id, author_name, text, created_at
                 FROM member_notes
                 WHERE application_id = ANY($1::int[])
                 ORDER BY created_at ASC, id ASC`,
                [ids]
            );
            const byApplication = {};
            notesRes.rows.forEach(n => {
                (byApplication[n.application_id] = byApplication[n.application_id] || []).push(n);
            });
            apps.forEach(a => { a.notes = byApplication[a.id] || []; });
        }

        res.json(apps);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Добавить комментарий модератора к заявке (с сайта)
app.post('/api/forms/applications/:id/notes', async (req, res) => {
    try {
        const applicationId = parseInt(req.params.id, 10);
        const text = String((req.body && req.body.text) || '').trim();

        if (!Number.isInteger(applicationId)) {
            return res.status(400).json({ error: 'Некорректный ID заявки' });
        }
        if (!text) {
            return res.status(400).json({ error: 'Введите текст комментария' });
        }
        if (text.length > 1000) {
            return res.status(400).json({ error: 'Комментарий не должен быть длиннее 1000 символов' });
        }

        const appRes = await db.query(`SELECT user_id FROM form_applications WHERE id = $1`, [applicationId]);
        if (!appRes.rows[0]) {
            return res.status(404).json({ error: 'Заявка не найдена' });
        }

        const authorId = (req.session.discordUser && req.session.discordUser.id) || null;
        const guildId = res.locals.guildId || process.env.GUILD_ID;

        const inserted = await db.query(
            `INSERT INTO member_notes (guild_id, user_id, author_id, author_name, application_id, text)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, application_id, author_id, author_name, text, created_at`,
            [guildId, appRes.rows[0].user_id, authorId, currentUserName(req), applicationId, text]
        );

        res.json({ success: true, note: inserted.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Статистика по заявкам: сводка, по формам, по дням, топ модераторов
app.get('/api/forms/applications/stats', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const allowedPeriods = [7, 30, 90, 365];
        const requested = parseInt(req.query.days, 10);
        const days = allowedPeriods.includes(requested) ? requested : 30;
        const interval = `${days} days`;

        const avgExpr = `ROUND((AVG(EXTRACT(EPOCH FROM (decided_at - created_at))) FILTER (WHERE decided_at IS NOT NULL) / 60)::numeric, 1)`;

        const summaryRes = await db.query(
            `SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
                COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                ${avgExpr} AS avg_minutes
             FROM form_applications
             WHERE guild_id = $1 AND created_at >= LOCALTIMESTAMP - $2::interval`,
            [guildId, interval]
        );

        const perFormRes = await db.query(
            `SELECT
                form_id,
                MAX(form_title) AS form_title,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
                COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                ${avgExpr} AS avg_minutes
             FROM form_applications
             WHERE guild_id = $1 AND created_at >= LOCALTIMESTAMP - $2::interval
             GROUP BY form_id
             ORDER BY total DESC
             LIMIT 20`,
            [guildId, interval]
        );

        const moderatorsRes = await db.query(
            `SELECT
                decided_by,
                COUNT(*)::int AS count,
                COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted
             FROM form_applications
             WHERE guild_id = $1 AND decided_by IS NOT NULL AND created_at >= LOCALTIMESTAMP - $2::interval
             GROUP BY decided_by
             ORDER BY count DESC
             LIMIT 5`,
            [guildId, interval]
        );

        // График по дням — не больше последних 30 дней, дни без заявок дают 0
        const dailyDays = Math.min(days, 30);
        const dailyRes = await db.query(
            `WITH bounds AS (SELECT date_trunc('day', LOCALTIMESTAMP) AS today)
             SELECT to_char(g.d, 'YYYY-MM-DD') AS day, COALESCE(c.cnt, 0)::int AS count
             FROM bounds, generate_series(bounds.today - $2::interval, bounds.today, interval '1 day') AS g(d)
             LEFT JOIN (
                SELECT date_trunc('day', created_at) AS day, COUNT(*) AS cnt
                FROM form_applications
                WHERE guild_id = $1 AND created_at >= (SELECT today FROM bounds) - $2::interval
                GROUP BY 1
             ) c ON c.day = g.d
             ORDER BY g.d`,
            [guildId, `${dailyDays - 1} days`]
        );

        const parseAvg = (v) => (v === null || v === undefined ? null : parseFloat(v));

        const summary = summaryRes.rows[0];
        res.json({
            days,
            summary: {
                total: summary.total,
                accepted: summary.accepted,
                rejected: summary.rejected,
                pending: summary.pending,
                avgMinutes: parseAvg(summary.avg_minutes)
            },
            perForm: perFormRes.rows.map(r => ({ ...r, avg_minutes: parseAvg(r.avg_minutes) })),
            moderators: moderatorsRes.rows,
            daily: dailyRes.rows
        });
    } catch (error) {
        console.error('Ошибка статистики заявок:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// API — Конструктор объявлений
// ==========================================

// Немедленная отправка
app.post('/api/announcements/send', async (req, res) => {
    try {
        const payload = announcements.sanitizePayload(req.body);
        const message = await announcements.sendAnnouncement(client, payload, {
            source: 'вручную',
            by: currentUserName(req)
        });
        res.json({ success: true, messageId: message.id });
    } catch (error) {
        res.status(400).json({ error: announcements.friendlyError(error) });
    }
});

// Редактирование уже отправленного сообщения
app.post('/api/announcements/edit', async (req, res) => {
    try {
        const payload = announcements.sanitizePayload(req.body);
        const messageId = String((req.body && req.body.messageId) || '').trim();
        const message = await announcements.editAnnouncement(client, messageId, payload, {
            by: currentUserName(req)
        });
        res.json({ success: true, messageId: message.id });
    } catch (error) {
        res.status(400).json({ error: announcements.friendlyError(error) });
    }
});

// Шаблоны
app.get('/api/announcements/templates', (req, res) => {
    try {
        res.json(announcementStore.getTemplates());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/announcements/templates', (req, res) => {
    try {
        const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
        if (!name) return res.status(400).json({ error: 'Укажите название шаблона' });

        const payload = announcements.sanitizePayload({ ...req.body, channelId: (req.body && req.body.channelId) || '000000000000000000' });
        // Шаблон не обязан содержать канал — если не выбран, храним пустым
        if (!(req.body && req.body.channelId)) payload.channelId = '';

        const template = announcementStore.addTemplate(name, payload);
        res.json({ success: true, template });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/announcements/templates/:id/delete', (req, res) => {
    try {
        const removed = announcementStore.deleteTemplate(req.params.id);
        if (!removed) return res.status(404).json({ error: 'Шаблон не найден' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Запланированные отправки
app.get('/api/announcements/scheduled', (req, res) => {
    try {
        const items = announcementStore.getScheduled()
            .map(i => ({
                id: i.id,
                sendAt: i.sendAt,
                status: i.status,
                error: i.error || '',
                channelId: i.payload.channelId,
                title: i.payload.title || '',
                hasImage: !!(i.payload.imageData || i.payload.imageUrl)
            }))
            .sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));
        res.json(items);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/announcements/schedule', (req, res) => {
    try {
        const payload = announcements.sanitizePayload(req.body);

        const sendAt = new Date(req.body && req.body.sendAt);
        if (isNaN(sendAt.getTime())) {
            return res.status(400).json({ error: 'Укажите корректную дату и время отправки' });
        }
        if (sendAt.getTime() <= Date.now()) {
            return res.status(400).json({ error: 'Время отправки должно быть в будущем' });
        }
        if (sendAt.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
            return res.status(400).json({ error: 'Нельзя планировать дальше чем на год вперёд' });
        }

        const item = announcementStore.addScheduled(payload, sendAt.toISOString());
        res.json({ success: true, id: item.id, sendAt: item.sendAt });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/announcements/scheduled/:id/cancel', (req, res) => {
    try {
        const removed = announcementStore.removeScheduled(req.params.id);
        if (!removed) return res.status(404).json({ error: 'Запись не найдена (возможно, уже отправлена)' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// API — Модерация: настройки логов
// ==========================================

app.get('/api/moderation/settings', requireGuildAccess, (req, res) => {
    try {
        res.json(moderationStore.getSettings(res.locals.guildId));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/moderation/settings', requireGuildAccess, (req, res) => {
    try {
        const { logChannelId, events } = req.body;
        const updated = moderationStore.updateSettings(res.locals.guildId, {
            ...(logChannelId !== undefined ? { logChannelId } : {}),
            ...(events && typeof events === 'object' ? { events } : {})
        });
        res.json({ success: true, settings: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// API — Модерация: журнал событий
// ==========================================

app.get('/api/moderation/logs', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const search = req.query.search ? req.query.search.trim() : '';
        const eventType = req.query.eventType ? req.query.eventType.trim() : '';
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

        let query = `SELECT * FROM mod_logs`;
        const conditions = [`guild_id = $1`];
        const params = [guildId];

        if (search) {
            params.push(`%${search}%`);
            conditions.push(`message ILIKE $${params.length}`);
        }
        if (eventType) {
            params.push(eventType);
            conditions.push(`event_type = $${params.length}`);
        }

        query += ` WHERE ` + conditions.join(' AND ');
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// API — Модерация: предупреждения (варны)
// ==========================================

app.get('/api/moderation/warnings', requireGuildAccess, async (req, res) => {
    try {
        const guildId = res.locals.guildId;
        const search = req.query.search ? req.query.search.trim() : '';
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);

        let query = `SELECT * FROM warnings WHERE guild_id = $1`;
        const params = [guildId];

        if (search) {
            params.push(`%${search}%`);
            query += ` AND (user_id ILIKE $${params.length} OR moderator_id ILIKE $${params.length} OR reason ILIKE $${params.length})`;
        }

        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/moderation/warnings/:id/delete', requireGuildAccess, async (req, res) => {
    try {
        const guildId = res.locals.guildId;
        await db.query('DELETE FROM warnings WHERE id = $1 AND guild_id = $2', [req.params.id, guildId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// API — Модерация: автомодерация
// ==========================================

app.get('/api/automod/settings', requireGuildAccess, (req, res) => {
    try {
        res.json(automodStore.getSettings(res.locals.guildId));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/automod/settings', requireGuildAccess, (req, res) => {
    try {
        const updated = automodStore.updateSettings(res.locals.guildId, req.body || {});
        res.json({ success: true, settings: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// API — Аналитика сервера
// ==========================================

app.get('/api/analytics/overview', requireGuildAccess, async (req, res) => {
    try {
        const guildId = res.locals.guildId;
        const days = req.query.days || 7;
        const data = await analyticsStore.getOverview(guildId, days);

        let totalMembers = null;
        const guild = client.guilds.cache.get(guildId);
        if (guild) totalMembers = guild.memberCount;

        res.json({ ...data, totalMembers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/series', requireGuildAccess, async (req, res) => {
    try {
        const guildId = res.locals.guildId;
        const days = req.query.days || 7;
        const type = req.query.type || 'messages';
        const data = await analyticsStore.getDailySeries(guildId, days, type);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/top-members', requireGuildAccess, async (req, res) => {
    try {
        const guildId = res.locals.guildId;
        const days = req.query.days || 7;
        const metric = req.query.metric || 'messages';
        const rows = await analyticsStore.getTopMembers(guildId, days, metric);

        const guild = client.guilds.cache.get(guildId);
        const enriched = await Promise.all(rows.map(async (row) => {
            let username = row.user_id;
            let avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
            try {
                const member = await guild.members.fetch(row.user_id);
                username = member.user.username;
                avatar = member.user.displayAvatarURL({ size: 64 });
            } catch (e) { /* участник мог покинуть сервер */ }
            return { userId: row.user_id, username, avatar, value: row.value };
        }));

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/top-channels', requireGuildAccess, async (req, res) => {
    try {
        const guildId = res.locals.guildId;
        const days = req.query.days || 7;
        const metric = req.query.metric || 'messages';
        const rows = await analyticsStore.getTopChannels(guildId, days, metric);

        const guild = client.guilds.cache.get(guildId);
        const enriched = rows.map(row => {
            const channel = guild ? guild.channels.cache.get(row.channel_id) : null;
            return { channelId: row.channel_id, name: channel ? channel.name : 'удалённый канал', value: row.value };
        });

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/status', requireGuildAccess, async (req, res) => {
    try {
        const guildId = res.locals.guildId;
        const days = req.query.days || 7;
        const data = await analyticsStore.getStatusSeries(guildId, days);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/analytics/heatmap', requireGuildAccess, async (req, res) => {
    try {
        const guildId = res.locals.guildId;
        const days = req.query.days || 30;
        const data = await analyticsStore.getHeatmap(guildId, days);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// API — Еженедельный отчёт (вкладка в категории «Аналитика»)
// ==========================================

app.get('/api/weekly-report/settings', requireGuildAccess, (req, res) => {
    try {
        res.json({ settings: weeklyReportStore.getSettings(res.locals.guildId), status: weeklyReportStore.getState(res.locals.guildId) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/weekly-report/settings', requireGuildAccess, (req, res) => {
    try {
        const draft = weeklyReportStore.sanitize(req.body, weeklyReportStore.getSettings(res.locals.guildId));
        if (draft.enabled && !draft.channelId) {
            return res.status(400).json({ error: 'Чтобы включить отчёт, выберите канал для отправки' });
        }
        const settings = weeklyReportStore.updateSettings(res.locals.guildId, req.body);
        res.json({ success: true, settings, status: weeklyReport.getStatus(res.locals.guildId) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/weekly-report/preview', requireGuildAccess, async (req, res) => {
    try {
        res.json(await weeklyReport.buildPreview(client, req.body, res.locals.guildId));
    } catch (error) {
        res.status(400).json({ error: weeklyReport.friendlyError(error) });
    }
});

app.post('/api/weekly-report/send', requireGuildAccess, async (req, res) => {
    try {
        const message = await weeklyReport.sendNow(client, req.body, currentUserName(req), res.locals.guildId);
        res.json({ success: true, messageId: message.id });
    } catch (error) {
        res.status(400).json({ error: weeklyReport.friendlyError(error) });
    }
});

// ==========================================
// API — Система отслеживания матов
// ==========================================

const swearWordsStore = require('./swearWordsStore.js');
const analyticsTracker = require('./analyticsTracker.js');

// Получить статистику матов
app.get('/api/swear-words/stats', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const days = req.query.days || 30;
        const stats = await analyticsStore.getSwearStats(guildId, days);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Получить список слов-матов
app.get('/api/swear-words', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const words = await swearWordsStore.getSwearWords(guildId);
        res.json(words);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Добавить слово-мат
app.post('/api/swear-words', async (req, res) => {
    try {
        const { word } = req.body;
        if (!word || !word.trim()) {
            return res.status(400).json({ error: 'Укажите слово' });
        }

        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const addedBy = (req.session.discordUser && req.session.discordUser.id) || null;

        const result = await swearWordsStore.addSwearWord(guildId, word.trim(), addedBy);

        if (result) {
            // Обновляем кэш слов-матов, чтобы бот начал их отслеживать сразу
            await analyticsTracker.loadSwearWords();
            res.json({ success: true, word: result.word });
        } else {
            res.status(400).json({ error: 'Слово уже существует в списке' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Удалить слово-мат
app.delete('/api/swear-words/:word', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const word = req.params.word;

        await swearWordsStore.removeSwearWord(guildId, word);

        // Обновляем кэш слов-матов
        await analyticsTracker.loadSwearWords();

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Получить статистику матов пользователя
app.get('/api/swear-words/user/:userId', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const userId = req.params.userId;
        const days = req.query.days || 30;

        const stats = await swearWordsStore.getUserSwearStats(guildId, userId, days);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Планировщик еженедельного отчёта. Регистрируем здесь (как и moderationApi), чтобы не менять index.js.
weeklyReport.register(client, require('./logger.js').sendLog);

// Опросы: обработчики кнопок/модалок в Discord + планировщик отложенных опросов.
polls.register(client, require('./logger.js').sendLog);

// Дополнительные API модерации (настройки варнов и логов сообщений).
// Подключаем здесь, а не из index.js: так маршруты точно попадают ПОСЛЕ requireAuth
// и ДО обработчика ошибок, и порядок загрузки index.js/server.js больше не важен.
require('./moderationApi.js')(app);

// API вкладки «Опросы» (Оповещения → Опросы)
require('./pollApi.js')(app, { client, currentUserName, requireGuildAccess });

// Досье участника (вкладка в категории «Аналитика»): поиск, профиль, заметки модераторов.
require('./memberProfileApi.js')(app, { client, isOwnerSession, currentUserName });

// ==========================================
// API — Автороли (Reaction Roles)
// ==========================================

const reactionRolesStore = require('./reactionRolesStore.js');

// Получить все автороли
app.get('/api/reaction-roles', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const reactionRoles = await reactionRolesStore.getReactionRoles(guildId);
        res.json(reactionRoles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Создать новую автороль
app.post('/api/reaction-roles', async (req, res) => {
    try {
        const { title, description, color } = req.body;
        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Укажите заголовок автороли' });
        }

        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const reactionRole = await reactionRolesStore.createReactionRole(
            guildId,
            title.trim(),
            description || '',
            color || '#5865F2',
            req.body.image || null,
            null,
            null
        );

        res.json({ success: true, reactionRole });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Обновить автороль
app.put('/api/reaction-roles/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { title, description, color } = req.body;
        const guildId = res.locals.guildId || process.env.GUILD_ID;

        const reactionRole = await reactionRolesStore.updateReactionRole(
            guildId,
            id,
            title.trim(),
            description || '',
            color || '#5865F2',
            req.body.image || null
        );

        if (!reactionRole) {
            return res.status(404).json({ error: 'Автороль не найдена' });
        }

        res.json({ success: true, reactionRole });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Удалить автороль
app.delete('/api/reaction-roles/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        await reactionRolesStore.deleteReactionRole(guildId, id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Отправить автороль в Discord
app.post('/api/reaction-roles/:id/publish', async (req, res) => {
    try {
        console.log('=== Starting reaction role publish ===');
        const id = parseInt(req.params.id, 10);
        const { channelId } = req.body;
        console.log('Publish request:', { id, channelId });

        if (!channelId) {
            console.log('Error: No channelId provided');
            return res.status(400).json({ error: 'Укажите канал для отправки' });
        }

        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const reactionRole = await reactionRolesStore.getReactionRoleById(guildId, id);
        if (!reactionRole) {
            console.log('Error: Reaction role not found');
            return res.status(404).json({ error: 'Автороль не найдена' });
        }
        console.log('Reaction role found:', reactionRole);

        if (!client || !client.isReady()) {
            console.log('Error: Discord bot not ready');
            return res.status(500).json({ error: 'Discord бот еще не готов' });
        }

        const guild = client.guilds.cache.get(res.locals.guildId || process.env.GUILD_ID);
        if (!guild) {
            console.log('Error: Guild not found');
            return res.status(404).json({ error: 'Сервер не найден' });
        }
        console.log('Guild found:', guild.name);

        const channel = await guild.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
            console.log('Error: Channel not found or not text-based');
            return res.status(400).json({ error: 'Канал не найден или не является текстовым' });
        }
        console.log('Channel found:', channel.name);

        // Получаем функцию создания эмбед из reactionRoles.js
        const reactionRolesModule = require('./reactionRoles.js');
        const { createReactionRoleEmbed } = reactionRolesModule(client, require('./logger.js').sendLog);

        console.log('Reaction role data:', JSON.stringify(reactionRole, null, 2));

        const { embed, files } = await createReactionRoleEmbed(reactionRole);
        console.log('Created embed:', embed);
        console.log('Files to attach:', files.length);
        
        let message;
        try {
            message = await channel.send({ embeds: [embed], files });
            console.log('Message sent successfully:', message.id);
        } catch (sendErr) {
            console.error('Error sending message:', sendErr);
            return res.status(500).json({ error: `Ошибка отправки сообщения: ${sendErr.message}` });
        }

        // Добавляем реакции к сообщению
        if (reactionRole.mappings && reactionRole.mappings.length > 0) {
            console.log('Adding reactions for mappings:', reactionRole.mappings);
            for (const mapping of reactionRole.mappings) {
                try {
                    console.log(`Adding reaction: ${mapping.emoji}`);
                    await message.react(mapping.emoji);
                    console.log(`Successfully added reaction: ${mapping.emoji}`);
                } catch (err) {
                    console.error(`Ошибка добавления реакции ${mapping.emoji}:`, err.message);
                }
            }
        }

        // Обновляем информацию о сообщении в базе
        await reactionRolesStore.updateMessageInfo(guildId, id, channelId, message.id);
        console.log('Updated message info in database');

        console.log('=== Publish completed successfully ===');
        res.json({ success: true, channelId, messageId: message.id });
    } catch (err) {
        console.error('=== Publish error ===');
        console.error('Error details:', err);
        console.error('Error stack:', err.stack);
        res.status(500).json({ error: err.message });
    }
});

// Добавить маппинг эмодзи-роль
app.post('/api/reaction-roles/:id/mappings', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { emoji, roleId, label } = req.body;
        const guildId = res.locals.guildId || process.env.GUILD_ID;

        if (!emoji || !roleId) {
            return res.status(400).json({ error: 'Укажите эмодзи и роль' });
        }

        // Проверяем, что роль есть на этом сервере
        const guild = client.guilds.cache.get(guildId);
        if (guild && !guild.roles.cache.has(roleId)) {
            return res.status(400).json({ error: 'Роль не найдена на этом сервере' });
        }

        const mapping = await reactionRolesStore.addMapping(guildId, id, emoji, roleId, label || '');
        res.json({ success: true, mapping });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Удалить маппинг
app.delete('/api/reaction-roles/:id/mappings/:mappingId', async (req, res) => {
    try {
        const mappingId = parseInt(req.params.mappingId, 10);
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        await reactionRolesStore.deleteMapping(guildId, mappingId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Обновить маппинг
app.put('/api/reaction-roles/:id/mappings/:mappingId', async (req, res) => {
    try {
        const mappingId = parseInt(req.params.mappingId, 10);
        const { emoji, roleId, label } = req.body;
        const guildId = res.locals.guildId || process.env.GUILD_ID;

        if (!emoji || !roleId) {
            return res.status(400).json({ error: 'Укажите эмодзи и роль' });
        }

        const mapping = await reactionRolesStore.updateMapping(guildId, mappingId, emoji, roleId, label || '');
        res.json({ success: true, mapping });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// API — Система уровней и XP
// ==========================================

const levelsStore = require('./levelsStore.js');

// Получить настройки уровней
app.get('/api/levels/settings', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const settings = await levelsStore.getLevelSettings(guildId);
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Обновить настройки уровней
app.post('/api/levels/settings', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const settings = await levelsStore.updateLevelSettings(guildId, req.body);
        res.json({ success: true, settings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Получить лидерборд
app.get('/api/levels/leaderboard', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const limit = parseInt(req.query.limit) || 10;
        const leaderboard = await levelsStore.getLeaderboard(guildId, limit);
        
        // Обогащаем данными пользователей
        const guild = client.guilds.cache.get(guildId);
        const enriched = await Promise.all(leaderboard.map(async (entry, index) => {
            try {
                const member = await guild.members.fetch(entry.user_id);
                return {
                    rank: index + 1,
                    username: member.user.username,
                    avatar: member.user.displayAvatarURL({ size: 64 }),
                    ...entry
                };
            } catch (e) {
                return {
                    rank: index + 1,
                    username: 'Неизвестный пользователь',
                    avatar: 'https://cdn.discordapp.com/embed/avatars/0.png',
                    ...entry
                };
            }
        }));
        
        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Получить ранговую карточку пользователя
app.get('/api/levels/rank/:userId', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const userId = req.params.userId;
        const userLevel = await levelsStore.getUserLevel(guildId, userId);
        
        if (!userLevel) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        const progress = levelsStore.calculateLevelProgress(userLevel.xp, userLevel.level);
        
        res.json({
            ...userLevel,
            progress
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Получить статистику уровней
app.get('/api/levels/stats', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const stats = await levelsStore.getLevelStats(guildId);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Получить все награды за уровни
app.get('/api/levels/rewards', async (req, res) => {
    try {
        console.log('GET /api/levels/rewards - fetching rewards');
        const rewards = await levelsStore.getLevelRewards();
        console.log('Rewards from DB:', rewards);
        res.json(rewards);
    } catch (err) {
        console.error('Error fetching rewards:', err);
        res.status(500).json({ error: err.message });
    }
});

// Добавить награду за уровень
app.post('/api/levels/rewards', async (req, res) => {
    try {
        const { level, roleId, removePrevious } = req.body;
        console.log('POST /api/levels/rewards - adding reward:', { level, roleId, removePrevious });
        
        if (!level || !roleId) {
            return res.status(400).json({ error: 'Укажите уровень и роль' });
        }
        
        const reward = await levelsStore.addLevelReward(level, roleId, removePrevious);
        console.log('Reward added to DB:', reward);
        res.json({ success: true, reward });
    } catch (err) {
        console.error('Error adding reward:', err);
        res.status(500).json({ error: err.message });
    }
});

// Удалить награду за уровень
app.delete('/api/levels/rewards/:level', async (req, res) => {
    try {
        const level = parseInt(req.params.level, 10);
        await levelsStore.removeLevelReward(level);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Вручную изменить XP пользователя
app.post('/api/levels/xp/:userId', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const userId = req.params.userId;
        const { xp } = req.body;

        if (xp === undefined || xp === null) {
            return res.status(400).json({ error: 'Укажите количество XP' });
        }

        const userLevel = await levelsStore.setUserXp(guildId, userId, parseInt(xp, 10));
        res.json({ success: true, userLevel });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// API — Звуковые оповещения (Sound Player)
// ==========================================

const soundPlayer = require('./index.js').soundPlayer;
const recorder = require('./recorder.js');

// ==========================================
// API — VoiceMaster (управление голосовыми каналами)
// ==========================================

const voiceMasterModule = require('./voiceMaster.js');
const voiceMasterStore = {
    // Получить настройки пользователя
    getUserSettings: async (guildId, userId) => {
        try {
            const result = await db.query(
                'SELECT * FROM voicemaster_user_settings WHERE guild_id = $1 AND user_id = $2',
                [guildId, userId]
            );
            return result.rows[0] || null;
        } catch (err) {
            console.error('Ошибка получения настроек пользователя:', err.message);
            return null;
        }
    },
    // Сохранить настройки пользователя
    saveUserSettings: async (guildId, userId, settings) => {
        try {
            await db.query(`
                INSERT INTO voicemaster_user_settings (guild_id, user_id, channel_name, user_limit, bitrate, is_locked)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (guild_id, user_id)
                DO UPDATE SET channel_name = $3, user_limit = $4, bitrate = $5, is_locked = $6
            `,
                [guildId, userId, settings.channelName, settings.userLimit, settings.bitrate, settings.isLocked]
            );
            return true;
        } catch (err) {
            console.error('Ошибка сохранения настроек пользователя:', err.message);
            return false;
        }
    },
    // Получить настройки VoiceMaster
    getSettings: async (guildId) => {
        try {
            const result = await db.query(
                'SELECT * FROM voicemaster_settings WHERE guild_id = $1',
                [guildId]
            );
            return result.rows[0] || null;
        } catch (err) {
            console.error('Ошибка получения настроек VoiceMaster:', err.message);
            return null;
        }
    }
};

// Получить настройки пользователя для VoiceMaster
app.get('/api/voicemaster/settings', async (req, res) => {
    try {
        const userId = req.session.discordUser?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const settings = await voiceMasterStore.getUserSettings(guildId, userId);
        res.json(settings || { channel_name: null, user_limit: 0, bitrate: 64000, is_locked: false });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Обновить настройки пользователя для VoiceMaster
app.post('/api/voicemaster/settings', async (req, res) => {
    try {
        const userId = req.session.discordUser?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const { channelName, userLimit, bitrate, isLocked } = req.body;

        const settings = {
            channelName: channelName || null,
            userLimit: userLimit !== undefined ? parseInt(userLimit, 10) : 0,
            bitrate: bitrate || 64000,
            isLocked: isLocked || false
        };

        const success = await voiceMasterStore.saveUserSettings(guildId, userId, settings);

        if (success) {
            // Если пользователь в голосовом канале, применим настройки
            const member = await client.guilds.cache.get(guildId)?.members.fetch(userId).catch(() => null);
            if (member && member.voice.channel) {
                const voiceChannel = member.voice.channel;
                
                // Переименовать канал
                if (settings.channelName) {
                    await voiceChannel.setName(settings.channelName);
                }
                
                // Установить лимит
                if (settings.userLimit > 0) {
                    await voiceChannel.setUserLimit(settings.userLimit);
                }
                
                // Установить битрейт
                if (settings.bitrate) {
                    await voiceChannel.setBitrate(settings.bitrate);
                }
            }
            
            res.json({ success: true, settings });
        } else {
            res.status(500).json({ error: 'Ошибка сохранения настроек' });
        }
    } catch (err) {
        console.error('Ошибка обновления настроек VoiceMaster:', err);
        res.status(500).json({ error: err.message });
    }
});

// Переименовать текущий голосовой канал пользователя
app.post('/api/voicemaster/rename', async (req, res) => {
    try {
        const userId = req.session.discordUser?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const { newName } = req.body;

        if (!newName || !newName.trim()) {
            return res.status(400).json({ error: 'Укажите название канала' });
        }

        const guild = client.guilds.cache.get(res.locals.guildId || process.env.GUILD_ID);
        if (!guild) {
            return res.status(404).json({ error: 'Сервер не найден' });
        }

        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member || !member.voice.channel) {
            return res.status(400).json({ error: 'Вы не в голосовом канале' });
        }

        const voiceChannel = member.voice.channel;
        await voiceChannel.setName(newName.trim());

        // Сохраняем в базу
        const currentSettings = await voiceMasterStore.getUserSettings(userId) || {};
        await voiceMasterStore.saveUserSettings(userId, {
            ...currentSettings,
            channelName: newName.trim()
        });

        res.json({ success: true, newName: newName.trim() });
    } catch (err) {
        console.error('Ошибка переименования канала:', err);
        res.status(500).json({ error: err.message });
    }
});

// Получить список всех загруженных звуков
app.get('/api/sounds', (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const sounds = soundPlayer.getSoundsList(guildId);
        res.json(sounds);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Загрузить новый звук
app.post('/api/sounds/upload', requireAuth, upload.single('sound'), async (req, res) => {
    try {
        console.log('Upload request received');
        console.log('File:', req.file);
        
        if (!req.file) {
            console.log('No file in request');
            return res.status(400).json({ error: 'Файл не загружен' });
        }

        const soundFile = req.file;
        const allowedExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.m4a'];
        const fileExt = path.extname(soundFile.originalname).toLowerCase();

        if (!allowedExtensions.includes(fileExt)) {
            console.log('Invalid file extension:', fileExt);
            // Удаляем временный файл
            if (fs.existsSync(soundFile.path)) {
                fs.unlinkSync(soundFile.path);
            }
            return res.status(400).json({ error: 'Неподдерживаемый формат файла. Разрешены: mp3, wav, ogg, flac, m4a' });
        }

        // Ограничение размера 10MB
        if (soundFile.size > 10 * 1024 * 1024) {
            console.log('File too large:', soundFile.size);
            // Удаляем временный файл
            if (fs.existsSync(soundFile.path)) {
                fs.unlinkSync(soundFile.path);
            }
            return res.status(400).json({ error: 'Файл слишком большой. Максимальный размер: 10MB' });
        }

        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const soundsDir = path.join(__dirname, 'data', 'sounds', guildId);
        if (!fs.existsSync(soundsDir)) {
            fs.mkdirSync(soundsDir, { recursive: true });
        }

        const filePath = path.join(soundsDir, soundFile.originalname);

        // Если файл с таким именем уже существует, добавляем суффикс
        let finalPath = filePath;
        let counter = 1;
        while (fs.existsSync(finalPath)) {
            const nameWithoutExt = path.parse(soundFile.originalname).name;
            const ext = path.parse(soundFile.originalname).ext;
            finalPath = path.join(soundsDir, `${nameWithoutExt}_${counter}${ext}`);
            counter++;
        }
        
        fs.renameSync(soundFile.path, finalPath);
        console.log('File saved to:', finalPath);

        const finalFilename = path.basename(finalPath);
        res.json({ success: true, filename: finalFilename });
    } catch (err) {
        console.error('Ошибка загрузки звука:', err.message);
        console.error('Error stack:', err.stack);
        
        // Удаляем временный файл при ошибке
        if (req.file && fs.existsSync(req.file.path)) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (cleanupErr) {
                console.error('Ошибка удаления временного файла:', cleanupErr.message);
            }
        }
        
        res.status(500).json({ error: err.message });
    }
});

// Удалить звук
app.delete('/api/sounds/:filename', requireAuth, (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const filename = req.params.filename;
        const deleted = soundPlayer.deleteSound(guildId, filename);

        if (!deleted) {
            return res.status(404).json({ error: 'Файл не найден' });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Получить список голосовых каналов
app.get('/api/sounds/channels', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const channels = await soundPlayer.getVoiceChannels(guildId);
        res.json(channels);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Получить участников в голосовом канале
app.get('/api/sounds/channels/:channelId/members', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const channelId = req.params.channelId;
        const result = await soundPlayer.getChannelMembers(guildId, channelId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Воспроизвести звук в канале
app.post('/api/sounds/play', requireAuth, async (req, res) => {
    try {
        console.log('=== API: Play sound request ===');
        const { channelId, soundFilename } = req.body;
        console.log('Request body:', { channelId, soundFilename });

        if (!channelId || !soundFilename) {
            console.log('❌ Missing channelId or soundFilename');
            return res.status(400).json({ error: 'Укажите канал и имя файла' });
        }

        const guildId = res.locals.guildId || process.env.GUILD_ID;
        console.log('Calling soundPlayer.playSoundInChannel...');
        const result = await soundPlayer.playSoundInChannel(guildId, channelId, soundFilename);
        console.log('Result from soundPlayer:', result);

        if (!result.success) {
            console.log('❌ Playback failed:', result.error);
            return res.status(400).json({ error: result.error });
        }

        console.log('✅ Playback success');
        res.json({ success: true });
    } catch (err) {
        console.error('❌ API error:', err.message);
        console.error('Error stack:', err.stack);
        res.status(500).json({ error: err.message });
    }
});

// Остановить воспроизведение в канале
app.post('/api/sounds/stop', requireAuth, (req, res) => {
    try {
        const { channelId } = req.body;

        if (!channelId) {
            return res.status(400).json({ error: 'Укажите канал' });
        }

        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const stopped = soundPlayer.stopSoundInChannel(guildId, channelId);
        res.json({ success: true, stopped });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// API — Запись голосовых каналов (recorder.js)
// ==========================================

app.post('/api/recorder/start', requireAuth, async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const { channelId } = req.body;
        if (!channelId) return res.status(400).json({ error: 'Укажите канал' });
        res.json({ success: true, ...(await recorder.startRecording(client, guildId, channelId)) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/recorder/stop', requireAuth, async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        res.json({ success: true, ...(await recorder.stopRecording(guildId)) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/recorder/list', requireAuth, (req, res) => res.json(recorder.listRecordings()));

app.get('/api/recorder/status', requireAuth, (req, res) => {
    const guildId = res.locals.guildId || process.env.GUILD_ID;
    res.json(recorder.getRecordingStatus(guildId));
});

app.delete('/api/recorder/:dir/:file', requireAuth, (req, res) => {
    try {
        const deleted = recorder.deleteRecording(req.params.dir, req.params.file);
        if (!deleted) return res.status(404).json({ error: 'Файл не найден' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/recorder/download/:dir/:file', requireAuth, (req, res) => {
    const full = recorder.getRecordingFile(req.params.dir, req.params.file);
    if (!full) return res.status(404).json({ error: 'Файл не найден' });
    res.download(full);
});

// Сбросить XP всех пользователей
app.post('/api/levels/reset-all', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const result = await levelsStore.resetAllXp(guildId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Сбросить XP конкретного пользователя
app.post('/api/levels/reset/:userId', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const userId = req.params.userId;
        const result = await levelsStore.resetUserXp(guildId, userId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// API — Система защиты сервера
// ==========================================

const securityStore = require('./securityStore.js');

// Получить настройки защиты
app.get('/api/security/settings', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const settings = await securityStore.getSecuritySettings(guildId);
        res.json(settings || { enabled: true, notification_channel_id: null });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Обновить настройки защиты
app.post('/api/security/settings', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const { enabled, notification_channel_id } = req.body;
        const settings = await securityStore.upsertSecuritySettings(guildId, { enabled, notification_channel_id });
        res.json({ success: true, settings });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Получить все ограничения
app.get('/api/security/restrictions', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const restrictions = await securityStore.getAllRestrictions(guildId);
        
        // Обогащаем информацией о пользователях
        const guild = client.guilds.cache.get(guildId);
        const enriched = await Promise.all(restrictions.map(async (r) => {
            let username = r.user_name || r.user_id;
            let avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
            if (guild) {
                try {
                    const user = await client.users.fetch(r.user_id);
                    username = user.username;
                    avatar = user.displayAvatarURL({ size: 64 });
                } catch (e) { }
            }
            return { ...r, username, avatar };
        }));
        
        res.json(enriched);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Получить ограничения конкретного пользователя
app.get('/api/security/restrictions/:userId', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const userId = req.params.userId;
        const restrictions = await securityStore.getUserRestrictions(guildId, userId);
        res.json(restrictions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Добавить ограничение
app.post('/api/security/restrictions', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const { userId, userName, restrictionType, restrictionMethod, notificationEnabled } = req.body;
        
        if (!userId || !restrictionType) {
            return res.status(400).json({ error: 'Укажите userId и restrictionType' });
        }
        
        const restriction = await securityStore.addRestriction(
            guildId, 
            userId, 
            userName || userId, 
            restrictionType, 
            restrictionMethod || 'block', 
            notificationEnabled || false
        );
        res.json({ success: true, restriction });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Удалить ограничение
app.delete('/api/security/restrictions/:userId/:restrictionType', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const { userId, restrictionType } = req.params;
        await securityStore.removeRestriction(guildId, userId, restrictionType);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Удалить все ограничения пользователя
app.delete('/api/security/restrictions/:userId', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const userId = req.params.userId;
        await securityStore.removeAllUserRestrictions(guildId, userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Получить белый список
app.get('/api/security/whitelist', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const whitelist = await securityStore.getWhitelist(guildId);
        
        // Обогащаем информацией о пользователях
        const guild = client.guilds.cache.get(guildId);
        const enriched = await Promise.all(whitelist.map(async (w) => {
            let username = w.user_name || w.user_id;
            let avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
            if (guild) {
                try {
                    const user = await client.users.fetch(w.user_id);
                    username = user.username;
                    avatar = user.displayAvatarURL({ size: 64 });
                } catch (e) { }
            }
            return { ...w, username, avatar };
        }));
        
        res.json(enriched);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Добавить в белый список
app.post('/api/security/whitelist', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const { userId, userName, isPermanent } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'Укажите userId' });
        }
        
        const addedBy = (req.session.discordUser && req.session.discordUser.id) || null;
        const entry = await securityStore.addToWhitelist(guildId, userId, userName || userId, isPermanent !== false, addedBy);
        res.json({ success: true, entry });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Удалить из белого списка
app.delete('/api/security/whitelist/:userId', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const userId = req.params.userId;
        await securityStore.removeFromWhitelist(guildId, userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Получить логи защиты
app.get('/api/security/logs', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        const logs = await securityStore.getSecurityLogs(guildId, limit);
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Получить бэкапы
app.get('/api/security/backups', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const backups = await securityStore.getBackups(guildId);
        res.json(backups);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Создать бэкап
app.post('/api/security/backups', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const { backupType, backupData } = req.body;
        
        if (!backupType || !backupData) {
            return res.status(400).json({ error: 'Укажите backupType и backupData' });
        }
        
        const createdBy = (req.session.discordUser && req.session.discordUser.id) || null;
        const backup = await securityStore.createBackup(guildId, backupType, backupData, createdBy);
        res.json({ success: true, backup });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Поиск пользователя по нику для добавления ограничений
app.get('/api/security/search-user', async (req, res) => {
    try {
        const guildId = res.locals.guildId || process.env.GUILD_ID;
        const query = req.query.q ? req.query.q.trim() : '';
        
        if (!query || query.length < 2) {
            return res.json([]);
        }
        
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Сервер не найден' });
        }
        
        // Поиск по имени пользователя
        const members = await guild.members.search({ query, limit: 10 });
        
        const results = members.map(member => ({
            id: member.user.id,
            username: member.user.username,
            displayName: member.displayName,
            avatar: member.user.displayAvatarURL({ size: 64 }),
            roles: member.roles.cache.map(r => ({ id: r.id, name: r.name, color: r.hexColor }))
        }));
        
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ловим ошибки, которые дошли досюда, не давая им обрушить весь процесс
app.use((err, req, res, next) => {
    console.error('❌ Необработанная ошибка в Express:', err);
    if (!res.headersSent) {
        res.status(500).send('Произошла внутренняя ошибка сервера. Подробности — в консоли бота.');
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Веб-панель запущена на порту ${PORT}`);
});

module.exports = { app };