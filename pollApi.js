const store = require('./pollStore.js');
const polls = require('./polls.js');

// API вкладки «Опросы». Подключается из server.js после requireAuth.
module.exports = function registerPollApi(app, { client, currentUserName, requireGuildAccess }) {

    const userId = (req) => (req.session && req.session.discordUser && req.session.discordUser.id) || null;
    const fail = (res, error, code = 400) => res.status(code).json({ error: polls.friendlyError(error) });

    function counts(guildId) {
        const all = store.getSuggestions(guildId);
        return {
            total: all.length,
            pending: all.filter(s => s.status === 'pending').length,
            approved: all.filter(s => s.status === 'approved').length,
            rejected: all.filter(s => s.status === 'rejected').length
        };
    }

    // ---------- Настройки ----------

    app.get('/api/polls/settings', (req, res) => {
        try {
            const guildId = res.locals.guildId || process.env.GUILD_ID;
            res.json({
                settings: store.getSettings(guildId),
                formMessage: store.getFormMessage(guildId),
                counts: counts(guildId),
                limits: store.LIMITS
            });
        } catch (error) {
            fail(res, error, 500);
        }
    });

    app.post('/api/polls/settings', requireGuildAccess, (req, res) => {
        try {
            const guildId = res.locals.guildId;
            const settings = store.updateSettings(guildId, req.body || {});
            res.json({ success: true, settings });
        } catch (error) {
            fail(res, error, 500);
        }
    });

    // Опубликовать (или обновить) сообщение с кнопкой «Предложить опрос»
    app.post('/api/polls/publish-form', requireGuildAccess, async (req, res) => {
        try {
            const guildId = res.locals.guildId;
            const { message, updated } = await polls.publishSuggestionForm(client, guildId);
            res.json({ success: true, updated, messageId: message.id });
        } catch (error) {
            fail(res, error);
        }
    });

    // ---------- Предложения ----------

    app.get('/api/polls/suggestions', requireGuildAccess, (req, res) => {
        try {
            const guildId = res.locals.guildId;
            const status = String(req.query.status || '');
            let list = store.getSuggestions(guildId).slice();
            if (['pending', 'approved', 'rejected'].includes(status)) {
                list = list.filter(s => s.status === status);
            }
            list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            res.json({ items: list.slice(0, 200), counts: counts(guildId) });
        } catch (error) {
            fail(res, error, 500);
        }
    });

    app.post('/api/polls/suggestions/:id/approve', requireGuildAccess, async (req, res) => {
        try {
            const guildId = res.locals.guildId;
            const item = await polls.approveSuggestion(client, req.params.id, {
                channelId: String((req.body && req.body.channelId) || '').trim(),
                by: userId(req),
                byName: currentUserName(req),
                guildId
            });
            res.json({ success: true, item });
        } catch (error) {
            fail(res, error);
        }
    });

    app.post('/api/polls/suggestions/:id/reject', requireGuildAccess, async (req, res) => {
        try {
            const guildId = res.locals.guildId;
            const item = await polls.rejectSuggestion(client, req.params.id, {
                reason: req.body && req.body.reason,
                by: userId(req),
                byName: currentUserName(req),
                guildId
            });
            res.json({ success: true, item });
        } catch (error) {
            fail(res, error);
        }
    });

    app.post('/api/polls/suggestions/:id/edit', requireGuildAccess, async (req, res) => {
        try {
            const guildId = res.locals.guildId;
            const item = await polls.editSuggestion(client, req.params.id, req.body, guildId);
            res.json({ success: true, item });
        } catch (error) {
            fail(res, error);
        }
    });

    app.post('/api/polls/suggestions/:id/delete', requireGuildAccess, (req, res) => {
        try {
            const guildId = res.locals.guildId;
            const item = store.getSuggestion(guildId, req.params.id);
            if (!item) return res.status(404).json({ error: 'Предложение не найдено' });
            if (item.status === 'pending') {
                return res.status(400).json({ error: 'Сначала одобрите или отклоните предложение' });
            }
            store.removeSuggestion(guildId, req.params.id);
            res.json({ success: true });
        } catch (error) {
            fail(res, error, 500);
        }
    });

    // ---------- Конструктор: отправка, шаблоны, отложенные, история ----------

    app.post('/api/polls/send', requireGuildAccess, async (req, res) => {
        try {
            const guildId = res.locals.guildId;
            const message = await polls.sendNow(client, req.body, currentUserName(req), guildId);
            res.json({ success: true, messageId: message.id });
        } catch (error) {
            fail(res, error);
        }
    });

    app.get('/api/polls/templates', requireGuildAccess, (req, res) => {
        try {
            const guildId = res.locals.guildId;
            res.json(store.getTemplates(guildId));
        } catch (error) {
            fail(res, error, 500);
        }
    });

    app.post('/api/polls/templates', requireGuildAccess, (req, res) => {
        try {
            const guildId = res.locals.guildId;
            const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
            if (!name) return res.status(400).json({ error: 'Укажите название шаблона' });
            const payload = store.sanitizePoll(req.body, { channelRequired: false, guildId });
            res.json({ success: true, template: store.addTemplate(guildId, name, payload) });
        } catch (error) {
            fail(res, error);
        }
    });

    app.post('/api/polls/templates/:id/delete', requireGuildAccess, (req, res) => {
        try {
            const guildId = res.locals.guildId;
            if (!store.deleteTemplate(guildId, req.params.id)) return res.status(404).json({ error: 'Шаблон не найден' });
            res.json({ success: true });
        } catch (error) {
            fail(res, error, 500);
        }
    });

    app.get('/api/polls/scheduled', requireGuildAccess, (req, res) => {
        try {
            const guildId = res.locals.guildId;
            const items = store.getScheduled(guildId)
                .map(i => ({
                    id: i.id,
                    sendAt: i.sendAt,
                    status: i.status,
                    error: i.error || '',
                    channelId: i.payload.channelId,
                    question: i.payload.question,
                    optionsCount: i.payload.options.length
                }))
                .sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));
            res.json(items);
        } catch (error) {
            fail(res, error, 500);
        }
    });

    app.post('/api/polls/schedule', requireGuildAccess, (req, res) => {
        try {
            const guildId = res.locals.guildId;
            const payload = store.sanitizePoll(req.body, { guildId });
            const sendAt = new Date(req.body && req.body.sendAt);
            if (isNaN(sendAt.getTime())) return res.status(400).json({ error: 'Укажите корректную дату и время отправки' });
            if (sendAt.getTime() <= Date.now()) return res.status(400).json({ error: 'Время отправки должно быть в будущем' });
            if (sendAt.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
                return res.status(400).json({ error: 'Нельзя планировать дальше чем на год вперёд' });
            }
            const item = store.addScheduled(guildId, payload, sendAt.toISOString());
            res.json({ success: true, id: item.id, sendAt: item.sendAt });
        } catch (error) {
            fail(res, error);
        }
    });

    app.post('/api/polls/scheduled/:id/cancel', requireGuildAccess, (req, res) => {
        try {
            const guildId = res.locals.guildId;
            if (!store.removeScheduled(guildId, req.params.id)) {
                return res.status(404).json({ error: 'Запись не найдена (возможно, уже отправлена)' });
            }
            res.json({ success: true });
        } catch (error) {
            fail(res, error, 500);
        }
    });

    app.get('/api/polls/history', requireGuildAccess, (req, res) => {
        try {
            const guildId = res.locals.guildId;
            res.json(store.getHistory(guildId));
        } catch (error) {
            fail(res, error, 500);
        }
    });
};