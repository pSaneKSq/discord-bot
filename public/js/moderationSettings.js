document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('moderationSettingsPage');
    if (!page) return;

    const guildId = page.getAttribute('data-guild-id');
    const el = (id) => document.getElementById(id);

    const channelSelect = el('logChannelSelect');
    const eventWarn = el('eventWarn');
    const eventMembers = el('eventMembers');
    const eventSostav = el('eventSostav');
    const eventFormDecision = el('eventFormDecision');
    const eventAutomod = el('eventAutomod');
    const eventMessageEdit = el('eventMessageEdit');
    const eventMessageDelete = el('eventMessageDelete');
    const eventWeeklyReport = el('eventWeeklyReport');
    const eventPoll = el('eventPoll');
    const eventOther = el('eventOther');

    const warnExpireDays = el('warnExpireDays');
    const warnStepsList = el('warnStepsList');
    const warnStepsEmpty = el('warnStepsEmpty');
    const addWarnStepBtn = el('addWarnStepBtn');

    const messageLogEnabled = el('messageLogEnabled');
    const messageLogDays = el('messageLogDays');

    const saveButtons = document.querySelectorAll('.save-settings-btn');
    const savedMsgs = document.querySelectorAll('.settings-saved-msg');

    // ---------- Каналы ----------

    async function loadChannels(savedChannelId) {
        try {
            const res = await fetch(`/api/guilds/${guildId}/channels`);
            const channels = await res.json();
            channelSelect.innerHTML = '<option value="">Не выбрано</option>' +
                channels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
            if (savedChannelId) channelSelect.value = savedChannelId;
        } catch (err) {
            console.error('Ошибка загрузки каналов:', err);
            channelSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        }
    }

    // ---------- Ступени наказаний ----------

    function updateStepsEmpty() {
        warnStepsEmpty.style.display = warnStepsList.children.length ? 'none' : 'block';
    }

    function addStepRow(step) {
        const data = step || { count: 3, action: 'timeout', minutes: 60 };
        const row = document.createElement('div');
        row.className = 'warn-step-row d-flex align-items-center gap-2 flex-wrap mb-2';

        row.innerHTML = `
            <span class="text-muted small">При</span>
            <input type="number" min="1" max="50" class="form-control form-control-sm step-count" value="${Number(data.count) || 3}" style="width:75px;">
            <span class="text-muted small">активных →</span>
            <select class="form-select form-select-sm step-action" style="width:130px;">
                <option value="timeout">Таймаут</option>
                <option value="kick">Кик</option>
            </select>
            <input type="number" min="1" max="40320" class="form-control form-control-sm step-minutes" value="${Number(data.minutes) || 60}" style="width:95px;" title="Длительность таймаута в минутах">
            <span class="text-muted small step-minutes-label">мин.</span>
            <button type="button" class="btn btn-sm btn-outline-danger step-remove ms-auto" title="Удалить ступень"><i class="bi bi-trash"></i></button>
        `;

        const actionSelect = row.querySelector('.step-action');
        const minutesInput = row.querySelector('.step-minutes');
        const minutesLabel = row.querySelector('.step-minutes-label');

        actionSelect.value = data.action === 'kick' ? 'kick' : 'timeout';

        function toggleMinutes() {
            const isTimeout = actionSelect.value === 'timeout';
            minutesInput.style.display = isTimeout ? '' : 'none';
            minutesLabel.style.display = isTimeout ? '' : 'none';
        }
        actionSelect.addEventListener('change', toggleMinutes);
        toggleMinutes();

        row.querySelector('.step-remove').addEventListener('click', () => {
            row.remove();
            updateStepsEmpty();
        });

        warnStepsList.appendChild(row);
        updateStepsEmpty();
    }

    function renderSteps(steps) {
        warnStepsList.innerHTML = '';
        (steps || []).forEach(step => addStepRow(step));
        updateStepsEmpty();
    }

    function collectSteps() {
        return Array.from(warnStepsList.querySelectorAll('.warn-step-row')).map(row => ({
            count: parseInt(row.querySelector('.step-count').value, 10),
            action: row.querySelector('.step-action').value,
            minutes: parseInt(row.querySelector('.step-minutes').value, 10)
        }));
    }

    addWarnStepBtn.addEventListener('click', () => {
        if (warnStepsList.children.length >= 8) {
            alert('Можно настроить не больше 8 ступеней');
            return;
        }
        addStepRow();
    });

    // ---------- Загрузка / сохранение ----------

    function applySettings(settings) {
        eventWarn.checked = settings.events.warn !== false;
        eventMembers.checked = settings.events.member_join !== false || settings.events.member_leave !== false;
        eventSostav.checked = settings.events.sostav_call !== false;
        eventFormDecision.checked = settings.events.form_decision !== false;
        eventAutomod.checked = settings.events.automod !== false;
        // Правки и удаления сообщений в Discord дублируются только если явно включены
        eventMessageEdit.checked = settings.events.message_edit === true;
        eventMessageDelete.checked = settings.events.message_delete === true;
        eventWeeklyReport.checked = settings.events.weekly_report !== false;
        eventPoll.checked = settings.events.poll !== false;
        eventOther.checked = settings.events.other !== false;

        const warnings = settings.warnings || { expireDays: 30, steps: [] };
        warnExpireDays.value = warnings.expireDays;
        renderSteps(warnings.steps);

        const messageLog = settings.messageLog || { enabled: true, retentionDays: 30 };
        messageLogEnabled.checked = messageLog.enabled !== false;
        messageLogDays.value = messageLog.retentionDays;
    }

    async function loadSettings() {
        try {
            const res = await fetch('/api/moderation/settings');
            const settings = await res.json();

            await loadChannels(settings.logChannelId);
            applySettings(settings);
        } catch (err) {
            console.error('Ошибка загрузки настроек модерации:', err);
        }
    }

    async function saveAll() {
        const mainRes = await fetch('/api/moderation/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                logChannelId: channelSelect.value,
                events: {
                    warn: eventWarn.checked,
                    member_join: eventMembers.checked,
                    member_leave: eventMembers.checked,
                    sostav_call: eventSostav.checked,
                    form_decision: eventFormDecision.checked,
                    automod: eventAutomod.checked,
                    message_edit: eventMessageEdit.checked,
                    message_delete: eventMessageDelete.checked,
                    weekly_report: eventWeeklyReport.checked,
                    poll: eventPoll.checked,
                    other: eventOther.checked
                }
            })
        });
        const mainData = await mainRes.json();
        if (!mainRes.ok || !mainData.success) throw new Error(mainData.error || 'Не удалось сохранить основные настройки');

        const extraRes = await fetch('/api/moderation/extra-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                warnings: {
                    expireDays: parseInt(warnExpireDays.value, 10),
                    steps: collectSteps()
                },
                messageLog: {
                    enabled: messageLogEnabled.checked,
                    retentionDays: parseInt(messageLogDays.value, 10)
                }
            })
        });
        const extraData = await extraRes.json();
        if (!extraRes.ok || !extraData.success) throw new Error(extraData.error || 'Не удалось сохранить настройки предупреждений');

        // Сервер мог поправить значения (убрать дубли, ограничить диапазоны) — показываем итог
        applySettings(extraData.settings);
    }

    saveButtons.forEach(btn => {
        btn.addEventListener('click', async () => {
            saveButtons.forEach(b => { b.disabled = true; });
            try {
                await saveAll();
                savedMsgs.forEach(m => {
                    m.style.display = 'inline-block';
                    setTimeout(() => { m.style.display = 'none'; }, 2500);
                });
            } catch (err) {
                console.error('Ошибка сохранения настроек модерации:', err);
                alert('Ошибка сохранения: ' + err.message);
            } finally {
                saveButtons.forEach(b => { b.disabled = false; });
            }
        });
    });

    loadSettings();
});