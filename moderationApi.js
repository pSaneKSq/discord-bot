const moderationStore = require('./moderationStore.js');

// Дополнительные API модерации. Подключается из index.js после server.js.
// Все маршруты /api/* уже защищены requireAuth, который зарегистрирован в server.js раньше.
module.exports = function registerModerationApi(app) {

    // Настройки варнов (срок действия, ступени наказаний) и логов правок/удалений
    app.post('/api/moderation/extra-settings', (req, res) => {
        try {
            const { warnings, messageLog } = req.body || {};
            const updated = moderationStore.updateSettings({
                ...(warnings ? { warnings } : {}),
                ...(messageLog ? { messageLog } : {})
            });
            res.json({ success: true, settings: updated });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
};