const { createMultiServerStore } = require('./multiServerStore');

const DEFAULT_TIMEZONE = 'Europe/Berlin';

const SECTION_KEYS = [
    'members',          // участники: пришло / ушло / всего
    'applications',     // заявки: подано / принято / отклонено
    'warnings',         // выдано предупреждений
    'activity',         // сообщения, часы в войсе, активные участники
    'activeChannel',    // самый активный канал
    'comparison',       // сравнение с прошлой неделей (▲▼)
    'topMessages',      // топ по сообщениям за неделю
    'topVoice',         // топ по войсу за неделю
    'allTimeMessages',  // топ по сообщениям за всё время
    'allTimeVoice',     // топ по войсу за всё время
    'levels',           // топ по уровням и XP
    'swears'            // статистика матов
];

const DEFAULT_SETTINGS = {
    enabled: false,
    channelId: '',
    dayOfWeek: 1,            // 0 = воскресенье, 1 = понедельник ... 6 = суббота
    time: '18:00',           // ЧЧ:ММ в выбранном часовом поясе
    timezone: DEFAULT_TIMEZONE,
    pingRole: '',            // '' | 'everyone' | ID роли
    content: '',             // обычный текст над эмбедом
    topLimit: 5,             // сколько строк в топах (3–10)
    embed: {
        color: '#8b5cf6',
        title: '📊 Еженедельный отчёт — {server}',
        description: 'Итоги недели: {from} — {to}',
        footer: '',
        imageUrl: '',
        thumbnail: true,     // иконка сервера справа сверху
        timestamp: true
    },
    sections: {
        members: true,
        applications: true,
        warnings: true,
        activity: true,
        activeChannel: true,
        comparison: true,
        topMessages: true,
        topVoice: true,
        allTimeMessages: true,
        allTimeVoice: true,
        levels: true,
        swears: true
    }
};

// Служебное состояние: клиент его изменить не может
const DEFAULT_STATE = {
    enabledSince: 0,        // отчёты за время до этого момента не считаются «пропущенными»
    lastHandledSlot: 0,     // метка времени последнего обработанного (отправленного или пропущенного) слота
    lastSentAt: 0,
    lastSkippedAt: 0,
    lastSkipText: '',
    lastError: '',
    allTimeBackfilled: false
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createDefault() {
    return {
        settings: clone(DEFAULT_SETTINGS),
        state: clone(DEFAULT_STATE)
    };
}

const storage = createMultiServerStore('weeklyReportSettings.json', createDefault);

function isValidTimezone(tz) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch (err) {
        return false;
    }
}

function str(value, max) {
    return String(value === undefined || value === null ? '' : value).slice(0, max);
}

// Проверяет и чистит настройки; всё некорректное заменяется значением из current
function sanitize(input, current) {
    const src = input && typeof input === 'object' ? input : {};
    const out = clone(current);

    if (src.enabled !== undefined) out.enabled = !!src.enabled;

    if (src.channelId !== undefined) {
        const id = str(src.channelId, 30).trim();
        out.channelId = /^\d{15,25}$/.test(id) ? id : '';
    }

    if (src.dayOfWeek !== undefined) {
        const d = parseInt(src.dayOfWeek, 10);
        if (Number.isFinite(d) && d >= 0 && d <= 6) out.dayOfWeek = d;
    }

    if (src.time !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(src.time))) {
        out.time = String(src.time);
    }

    if (src.timezone !== undefined && isValidTimezone(String(src.timezone))) {
        out.timezone = String(src.timezone);
    }

    if (src.pingRole !== undefined) {
        const p = str(src.pingRole, 30).trim();
        out.pingRole = (p === 'everyone' || /^\d{15,25}$/.test(p)) ? p : '';
    }

    if (src.content !== undefined) out.content = str(src.content, 1000);

    if (src.topLimit !== undefined) {
        const n = parseInt(src.topLimit, 10);
        if (Number.isFinite(n)) out.topLimit = Math.min(Math.max(n, 3), 10);
    }

    if (src.embed && typeof src.embed === 'object') {
        const e = src.embed;
        if (e.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(String(e.color))) out.embed.color = String(e.color);
        if (e.title !== undefined) out.embed.title = str(e.title, 256);
        if (e.description !== undefined) out.embed.description = str(e.description, 2000);
        if (e.footer !== undefined) out.embed.footer = str(e.footer, 200);
        if (e.imageUrl !== undefined) {
            const url = str(e.imageUrl, 500).trim();
            out.embed.imageUrl = /^https?:\/\//i.test(url) ? url : '';
        }
        if (e.thumbnail !== undefined) out.embed.thumbnail = !!e.thumbnail;
        if (e.timestamp !== undefined) out.embed.timestamp = !!e.timestamp;
    }

    if (src.sections && typeof src.sections === 'object') {
        for (const key of SECTION_KEYS) {
            if (src.sections[key] !== undefined) out.sections[key] = !!src.sections[key];
        }
    }

    return out;
}

function getSettings(guildId) {
    const guildData = storage.get(guildId);
    return sanitize(guildData.settings, clone(DEFAULT_SETTINGS));
}

function getState(guildId) {
    const guildData = storage.get(guildId);
    return { ...DEFAULT_STATE, ...(guildData.state || {}) };
}

function updateSettings(guildId, partial) {
    const guildData = storage.get(guildId);
    const current = sanitize(guildData.settings, clone(DEFAULT_SETTINGS));
    const updated = sanitize(partial, current);
    const state = { ...DEFAULT_STATE, ...(guildData.state || {}) };

    const scheduleChanged =
        updated.dayOfWeek !== current.dayOfWeek ||
        updated.time !== current.time ||
        updated.timezone !== current.timezone;

    if (updated.enabled && (!current.enabled || scheduleChanged)) {
        state.enabledSince = Date.now();
    }

    storage.set(guildId, { settings: updated, state });
    return updated;
}

function updateState(guildId, patch) {
    const guildData = storage.get(guildId);
    const settings = sanitize(guildData.settings, clone(DEFAULT_SETTINGS));
    const state = { ...DEFAULT_STATE, ...(guildData.state || {}), ...patch };
    storage.set(guildId, { settings, state });
    return state;
}

module.exports = {
    DEFAULT_SETTINGS,
    SECTION_KEYS,
    sanitize,
    getSettings,
    updateSettings,
    getState,
    updateState,
    getAll: () => storage.getAll(),
    guildIds: () => storage.guildIds()
};