const { createMultiServerStore } = require('./multiServerStore.js');

const store = createMultiServerStore('forms.json', () => ({}));

function createDefaultForm(id, overrides = {}) {
    return {
        id,
        channelId: '',
        messageId: '',
        embedTitle: 'Заявка',
        embedDesc: '',
        embedColor: '#8b5cf6',
        embedAuthor: '',
        buttonText: 'Подать заявку',
        imageUrl: '',
        questions: [],
        settings: { reviewChannelId: '', logChannelId: '', cooldownMinutes: 5 },
        actions: {
            accept: { dm: '', addRoles: [], removeRoles: [] },
            reject: { dm: '', addRoles: [], removeRoles: [] }
        },
        ...overrides
    };
}

// { formId: formData } для конкретного сервера
function getFormsStorage(guildId) { return store.get(guildId); }
function saveForms() { store.save(); }

module.exports = { createDefaultForm, getFormsStorage, saveForms };
