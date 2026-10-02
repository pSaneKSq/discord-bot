const { createMultiServerStore } = require('./multiServerStore');

const DEFAULT_SETTINGS = {
    enabled: false,
    exemptRoleIds: [],
    bannedWords: {
        enabled: false,
        words: []
    },
    spam: {
        enabled: false,
        maxMessages: 5,
        perSeconds: 5
    },
    caps: {
        enabled: false,
        minLength: 10,
        maxPercent: 70
    },
    invites: {
        enabled: false
    },
    mentionSpam: {
        enabled: false,
        maxMentions: 5
    },
    pedantry: {
        enabled: false,
        muteMinutes: 60,
        deleteMessage: false,
        sendDm: true,
        strictAsterisk: false,
        dmText: 'Ты сильно переусердствовал, когда поправлял других — отдохни. 😴\nТебе выдан мут на {duration}.',
        triggerPhrases: [
            'пишется через',
            'пишут через',
            'пишется с',
            'пишется без',
            'пишется слитно',
            'пишется раздельно',
            'правильно пишется',
            'правильно будет',
            'правильно говорить',
            'правильно писать'
        ]
    }
};

const storage = createMultiServerStore('automodSettings.json', () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));

const PEDANTRY_LIMITS = {
    minMinutes: 1,
    maxMinutes: 28 * 24 * 60,
    maxPhrases: 30,
    maxPhraseLength: 60,
    maxDmLength: 1000
};

function sanitizePedantry(input, base) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {
        ...base,
        triggerPhrases: Array.isArray(base.triggerPhrases) ? base.triggerPhrases.slice() : []
    };

    if (src.enabled !== undefined) out.enabled = !!src.enabled;
    if (src.deleteMessage !== undefined) out.deleteMessage = !!src.deleteMessage;
    if (src.sendDm !== undefined) out.sendDm = !!src.sendDm;
    if (src.strictAsterisk !== undefined) out.strictAsterisk = !!src.strictAsterisk;

    if (src.muteMinutes !== undefined) {
        const n = parseInt(src.muteMinutes, 10);
        if (Number.isFinite(n)) {
            out.muteMinutes = Math.min(PEDANTRY_LIMITS.maxMinutes, Math.max(PEDANTRY_LIMITS.minMinutes, n));
        }
    }

    if (typeof src.dmText === 'string') {
        const text = src.dmText.trim().slice(0, PEDANTRY_LIMITS.maxDmLength);
        out.dmText = text || DEFAULT_SETTINGS.pedantry.dmText;
    }

    if (Array.isArray(src.triggerPhrases)) {
        const cleaned = src.triggerPhrases
            .map(p => String(p || '').trim().toLowerCase().slice(0, PEDANTRY_LIMITS.maxPhraseLength))
            .filter(Boolean);
        out.triggerPhrases = Array.from(new Set(cleaned)).slice(0, PEDANTRY_LIMITS.maxPhrases);
    }

    return out;
}

function getSettings(guildId) {
    const settings = storage.get(guildId);
    return {
        enabled: !!settings.enabled,
        exemptRoleIds: Array.isArray(settings.exemptRoleIds) ? settings.exemptRoleIds : [],
        bannedWords: { ...DEFAULT_SETTINGS.bannedWords, ...(settings.bannedWords || {}) },
        spam: { ...DEFAULT_SETTINGS.spam, ...(settings.spam || {}) },
        caps: { ...DEFAULT_SETTINGS.caps, ...(settings.caps || {}) },
        invites: { ...DEFAULT_SETTINGS.invites, ...(settings.invites || {}) },
        mentionSpam: { ...DEFAULT_SETTINGS.mentionSpam, ...(settings.mentionSpam || {}) },
        pedantry: sanitizePedantry(settings.pedantry, DEFAULT_SETTINGS.pedantry)
    };
}

function updateSettings(guildId, partial) {
    const current = getSettings(guildId);
    const updated = {
        enabled: partial.enabled !== undefined ? !!partial.enabled : current.enabled,
        exemptRoleIds: Array.isArray(partial.exemptRoleIds) ? partial.exemptRoleIds : current.exemptRoleIds,
        bannedWords: { ...current.bannedWords, ...(partial.bannedWords || {}) },
        spam: { ...current.spam, ...(partial.spam || {}) },
        caps: { ...current.caps, ...(partial.caps || {}) },
        invites: { ...current.invites, ...(partial.invites || {}) },
        mentionSpam: { ...current.mentionSpam, ...(partial.mentionSpam || {}) },
        pedantry: sanitizePedantry(partial.pedantry, current.pedantry)
    };
    storage.set(guildId, updated);
    return updated;
}

module.exports = { getSettings, updateSettings };