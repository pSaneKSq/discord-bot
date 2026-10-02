const { createMultiServerStore } = require('./multiServerStore.js');

// Лимиты встроенных опросов Discord
const LIMITS = { question: 300, option: 55, minOptions: 2, maxOptions: 10, maxDuration: 168 };

const DEFAULT_SETTINGS = {
    suggestionChannelId: '',   // куда публиковать форму с кнопкой «Предложить опрос»
    reviewChannelId: '',       // единый канал проверки предложений
    publishChannelId: '',      // канал публикации одобренных по умолчанию
    approverRoleId: '',        // '' = право «Управлять сервером», иначе конкретная роль
    cooldownHours: 24,         // 1..24
    defaultDuration: 24,       // часы
    defaultMultiselect: false,

    formTitle: '📊 Предложи опрос для сервера',
    formDescription: 'Хочешь узнать мнение участников? Нажми кнопку, напиши вопрос и варианты ответа (каждый с новой строки). Администрация рассмотрит предложение, а подходящие опросы будут опубликованы.',
    formButtonText: 'Предложить опрос',
    formColor: '#8b5cf6',

    dmOnSubmit: true,
    dmOnApprove: true,
    dmOnReject: true,
    dmSubmitText: 'Твой опрос «{question}» принят на рассмотрение. Администрация скоро его посмотрит. ✅',
    dmApproveText: 'Твой опрос «{question}» одобрен и будет опубликован в ближайшее время! 🎉',
    dmRejectText: 'К сожалению, твой опрос «{question}» был отклонён.{reason}'
};

const TEXT_FIELDS = [
    ['formTitle', 256], ['formDescription', 2000], ['formButtonText', 80],
    ['dmSubmitText', 1000], ['dmApproveText', 1000], ['dmRejectText', 1000]
];
const BOOL_FIELDS = ['defaultMultiselect', 'dmOnSubmit', 'dmOnApprove', 'dmOnReject'];
const ID_FIELDS = ['suggestionChannelId', 'reviewChannelId', 'publishChannelId', 'approverRoleId'];

function emptyState() {
    return {
        settings: { ...DEFAULT_SETTINGS },
        suggestions: [],
        cooldowns: {},
        templates: [],
        scheduled: [],
        history: [],
        formMessage: null
    };
}

const storage = createMultiServerStore('pollSettings.json', emptyState);

function getGuildStorage(guildId) { return storage.get(guildId); }
function getAll() { return storage.getAll(); }

function makeId(prefix) {
    return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

// ---------- Проверка входных данных ----------

function sanitizeSettings(input, base) {
    const s = { ...base };
    input = input || {};

    ID_FIELDS.forEach(k => {
        if (k in input) {
            const v = String(input[k] || '').trim();
            s[k] = /^\d{15,25}$/.test(v) ? v : '';
        }
    });
    if ('cooldownHours' in input) s.cooldownHours = clampInt(input.cooldownHours, 1, 24, base.cooldownHours);
    if ('defaultDuration' in input) s.defaultDuration = clampInt(input.defaultDuration, 1, LIMITS.maxDuration, base.defaultDuration);
    BOOL_FIELDS.forEach(k => { if (k in input) s[k] = !!input[k]; });
    TEXT_FIELDS.forEach(([k, max]) => {
        if (k in input) {
            const v = String(input[k] || '').trim().slice(0, max);
            s[k] = v || base[k] || DEFAULT_SETTINGS[k];
        }
    });
    if ('formColor' in input) {
        const c = String(input.formColor || '').trim();
        s.formColor = /^#[0-9a-fA-F]{6}$/.test(c) ? c : base.formColor;
    }
    return s;
}

function normalizeOptions(raw) {
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/\r?\n/);
    const out = list.map(o => String(o || '').trim()).filter(Boolean);
    if (out.length < LIMITS.minOptions) throw new Error(`Нужно минимум ${LIMITS.minOptions} варианта ответа`);
    if (out.length > LIMITS.maxOptions) throw new Error(`Вариантов не может быть больше ${LIMITS.maxOptions}`);
    const tooLong = out.find(o => o.length > LIMITS.option);
    if (tooLong) throw new Error(`Вариант «${tooLong.slice(0, 20)}…» длиннее ${LIMITS.option} символов`);
    const seen = new Set();
    for (const o of out) {
        const key = o.toLowerCase();
        if (seen.has(key)) throw new Error(`Вариант «${o.slice(0, 20)}» повторяется`);
        seen.add(key);
    }
    return out;
}

function normalizeQuestion(raw) {
    const q = String(raw || '').trim();
    if (!q) throw new Error('Введите вопрос');
    if (q.length > LIMITS.question) throw new Error(`Вопрос длиннее ${LIMITS.question} символов`);
    return q;
}

// Полная проверка опроса из конструктора. channelRequired=false — для шаблонов.
function sanitizePoll(body, { channelRequired = true, guildId } = {}) {
    body = body || {};
    const settings = getSettings(guildId);
    const poll = {
        question: normalizeQuestion(body.question),
        options: normalizeOptions(body.options),
        duration: clampInt(body.duration, 1, LIMITS.maxDuration, settings.defaultDuration),
        multiselect: !!body.multiselect,
        channelId: String(body.channelId || '').trim(),
        pingRole: String(body.pingRole || '').trim()
    };
    if (channelRequired && !/^\d{15,25}$/.test(poll.channelId)) throw new Error('Выберите канал для отправки');
    if (!/^\d{15,25}$/.test(poll.channelId)) poll.channelId = '';
    if (poll.pingRole && poll.pingRole !== 'everyone' && !/^\d{15,25}$/.test(poll.pingRole)) poll.pingRole = '';
    return poll;
}

// ---------- Настройки ----------

function getSettings(guildId) {
    const s = getGuildStorage(guildId);
    s.settings = { ...DEFAULT_SETTINGS, ...s.settings };
    return s.settings;
}

function updateSettings(guildId, partial) {
    const storage = getGuildStorage(guildId);
    storage.settings = sanitizeSettings(partial, storage.settings);
    return storage.settings;
}

// ---------- Предложения ----------

function getSuggestions(guildId) {
    const storage = getGuildStorage(guildId);
    return storage.suggestions;
}

function getSuggestion(guildId, id) {
    const storage = getGuildStorage(guildId);
    return storage.suggestions.find(s => s.id === id) || null;
}

function addSuggestion(guildId, data) {
    const storage = getGuildStorage(guildId);
    const item = {
        id: makeId('p'),
        authorId: data.authorId,
        authorName: data.authorName || '',
        question: data.question,
        options: data.options,
        status: 'pending',
        rejectionReason: '',
        duplicateOf: data.duplicateOf || null,
        createdAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        decidedByName: '',
        reviewMessageId: null,
        reviewChannelId: null,
        publishedMessageId: null,
        publishedChannelId: null
    };
    storage.suggestions.push(item);
    return item;
}

function updateSuggestion(guildId, id, patch) {
    const storage = getGuildStorage(guildId);
    const item = storage.suggestions.find(s => s.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    return item;
}

function removeSuggestion(guildId, id) {
    const storage = getGuildStorage(guildId);
    const before = storage.suggestions.length;
    storage.suggestions = storage.suggestions.filter(s => s.id !== id);
    return storage.suggestions.length < before;
}

// ---------- Кулдауны ----------

function getCooldown(guildId, userId) {
    const storage = getGuildStorage(guildId);
    return Number(storage.cooldowns[userId]) || 0;
}

function setCooldown(guildId, userId, untilMs) {
    const storage = getGuildStorage(guildId);
    storage.cooldowns[userId] = untilMs;
    const now = Date.now();
    Object.keys(storage.cooldowns).forEach(k => { if (storage.cooldowns[k] < now) delete storage.cooldowns[k]; });
}

// ---------- Сообщение с формой ----------

function getFormMessage(guildId) {
    const storage = getGuildStorage(guildId);
    return storage.formMessage;
}

function setFormMessage(guildId, ref) {
    const storage = getGuildStorage(guildId);
    storage.formMessage = ref;
}

// ---------- Шаблоны ----------

function getTemplates(guildId) {
    const storage = getGuildStorage(guildId);
    return storage.templates;
}

function addTemplate(guildId, name, payload) {
    const storage = getGuildStorage(guildId);
    const t = { id: makeId('t'), name, payload, createdAt: new Date().toISOString() };
    storage.templates.push(t);
    return t;
}

function deleteTemplate(guildId, id) {
    const storage = getGuildStorage(guildId);
    const before = storage.templates.length;
    storage.templates = storage.templates.filter(t => t.id !== id);
    return storage.templates.length < before;
}

// ---------- Отложенные ----------

function getScheduled(guildId) {
    const storage = getGuildStorage(guildId);
    return storage.scheduled;
}

function addScheduled(guildId, payload, sendAt) {
    const storage = getGuildStorage(guildId);
    const item = { id: makeId('s'), payload, sendAt, status: 'pending', error: '', createdAt: new Date().toISOString() };
    storage.scheduled.push(item);
    return item;
}

function updateScheduled(guildId, id, patch) {
    const storage = getGuildStorage(guildId);
    const item = storage.scheduled.find(i => i.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    return item;
}

function removeScheduled(guildId, id) {
    const storage = getGuildStorage(guildId);
    const before = storage.scheduled.length;
    storage.scheduled = storage.scheduled.filter(i => i.id !== id);
    return storage.scheduled.length < before;
}

// ---------- История отправленных (для «Дублировать») ----------

function getHistory(guildId) {
    const storage = getGuildStorage(guildId);
    return storage.history;
}

function addHistory(guildId, entry) {
    const storage = getGuildStorage(guildId);
    storage.history.unshift({ ...entry, sentAt: new Date().toISOString() });
    storage.history = storage.history.slice(0, 30);
}

module.exports = {
    LIMITS, DEFAULT_SETTINGS,
    getSettings, updateSettings,
    getSuggestions, getSuggestion, addSuggestion, updateSuggestion, removeSuggestion,
    getCooldown, setCooldown,
    getFormMessage, setFormMessage,
    getTemplates, addTemplate, deleteTemplate,
    getScheduled, addScheduled, updateScheduled, removeScheduled,
    getHistory, addHistory,
    normalizeOptions, normalizeQuestion, sanitizePoll,
    getGuildStorage,
    getAll
};