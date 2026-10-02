const { createMultiServerStore } = require('./multiServerStore');

function emptyState() {
    return { templates: [], scheduled: [] };
}

const storage = createMultiServerStore('announcements.json', emptyState);

function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function getTemplates(guildId) {
    const guildStorage = storage.get(guildId);
    return guildStorage.templates || [];
}

function addTemplate(guildId, name, payload) {
    const guildStorage = storage.get(guildId);
    const { imageData, ...safePayload } = payload;
    const template = {
        id: makeId('tpl'),
        name,
        payload: safePayload,
        createdAt: new Date().toISOString()
    };
    guildStorage.templates.push(template);
    storage.set(guildId, guildStorage);
    return template;
}

function deleteTemplate(guildId, id) {
    const guildStorage = storage.get(guildId);
    const before = guildStorage.templates.length;
    guildStorage.templates = guildStorage.templates.filter(t => t.id !== id);
    storage.set(guildId, guildStorage);
    return guildStorage.templates.length < before;
}

function getScheduled(guildId) {
    const guildStorage = storage.get(guildId);
    return guildStorage.scheduled || [];
}

function addScheduled(guildId, payload, sendAt) {
    const guildStorage = storage.get(guildId);
    const item = {
        id: makeId('sch'),
        payload,
        sendAt,
        status: 'pending',
        error: '',
        createdAt: new Date().toISOString()
    };
    guildStorage.scheduled.push(item);
    storage.set(guildId, guildStorage);
    return item;
}

function updateScheduled(guildId, id, patch) {
    const guildStorage = storage.get(guildId);
    const item = guildStorage.scheduled.find(i => i.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    storage.set(guildId, guildStorage);
    return item;
}

function removeScheduled(guildId, id) {
    const guildStorage = storage.get(guildId);
    const before = guildStorage.scheduled.length;
    guildStorage.scheduled = guildStorage.scheduled.filter(i => i.id !== id);
    storage.set(guildId, guildStorage);
    return guildStorage.scheduled.length < before;
}

module.exports = {
    getTemplates,
    addTemplate,
    deleteTemplate,
    getScheduled,
    addScheduled,
    updateScheduled,
    removeScheduled
};