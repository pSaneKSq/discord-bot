const { createMultiServerStore } = require('./multiServerStore.js');

const ALLOWED_ACTIONS = ['timeout', 'kick'];
const MAX_TIMEOUT_MINUTES = 40320;

const DEFAULT_SETTINGS = {
    logChannelId: '',
    events: {
        warn: true,
        member_join: true,
        member_leave: true,
        sostav_call: true,
        form_decision: true,
        automod: true,
        message_edit: false,
        message_delete: false,
        weekly_report: true,
        poll: true,
        other: true
    },
    warnings: {
        expireDays: 30,
        steps: [{ count: 4, action: 'timeout', minutes: 10080 }]
    },
    messageLog: {
        enabled: true,
        retentionDays: 30
    }
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function toInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function sanitizeWarnings(input, current) {
    const result = { expireDays: current.expireDays, steps: current.steps };
    if (!input || typeof input !== 'object') return result;

    if (input.expireDays !== undefined) {
        const days = toInt(input.expireDays, current.expireDays);
        result.expireDays = Math.min(Math.max(days, 0), 3650);
    }

    if (Array.isArray(input.steps)) {
        const seen = new Set();
        const steps = [];

        for (const raw of input.steps) {
            const count = toInt(raw && raw.count, NaN);
            const action = raw && raw.action;
            if (!Number.isFinite(count) || count < 1 || count > 50) continue;
            if (!ALLOWED_ACTIONS.includes(action)) continue;
            if (seen.has(count)) continue;

            const step = { count, action };
            if (action === 'timeout') {
                let minutes = toInt(raw.minutes, 60);
                if (minutes < 1) minutes = 60;
                step.minutes = Math.min(minutes, MAX_TIMEOUT_MINUTES);
            }

            seen.add(count);
            steps.push(step);
        }

        steps.sort((a, b) => a.count - b.count);
        result.steps = steps.slice(0, 8);
    }

    return result;
}

function sanitizeMessageLog(input, current) {
    const result = { enabled: current.enabled, retentionDays: current.retentionDays };
    if (!input || typeof input !== 'object') return result;

    if (input.enabled !== undefined) result.enabled = !!input.enabled;
    if (input.retentionDays !== undefined) {
        const days = toInt(input.retentionDays, current.retentionDays);
        result.retentionDays = Math.min(Math.max(days, 1), 365);
    }
    return result;
}

const store = createMultiServerStore('moderationSettings.json', () => clone(DEFAULT_SETTINGS));

function getSettings(guildId) {
    const settings = store.get(guildId);
    const defaults = clone(DEFAULT_SETTINGS);
    return {
        logChannelId: settings.logChannelId || '',
        events: { ...defaults.events, ...(settings.events || {}) },
        warnings: sanitizeWarnings(settings.warnings, defaults.warnings),
        messageLog: sanitizeMessageLog(settings.messageLog, defaults.messageLog)
    };
}

function updateSettings(guildId, partial) {
    const current = getSettings(guildId);
    const updated = {
        logChannelId: partial.logChannelId !== undefined ? partial.logChannelId : current.logChannelId,
        events: { ...current.events, ...(partial.events || {}) },
        warnings: sanitizeWarnings(partial.warnings, current.warnings),
        messageLog: sanitizeMessageLog(partial.messageLog, current.messageLog)
    };
    store.set(guildId, updated);
    return updated;
}

module.exports = { getSettings, updateSettings };
