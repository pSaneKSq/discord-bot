document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('pollsPage');
    if (!page) return;

    const guildId = page.getAttribute('data-guild-id');
    const el = (id) => document.getElementById(id);
    const LIM = { question: 300, option: 55, min: 2, max: 10 };

    let channels = [];
    let roles = [];
    let templates = [];
    let suggestions = [];
    let filter = 'all';
    let currentSuggestion = null;
    let alertTimer = null;

    const alertBox = el('plAlert');
    const optionsBox = el('plOptions');

    // ---------- Вспомогательное ----------

    function showAlert(type, text) {
        alertBox.className = 'alert py-2 small mb-3 alert-' + type;
        alertBox.textContent = text;
        alertBox.style.display = 'block';
        clearTimeout(alertTimer);
        alertTimer = setTimeout(() => { alertBox.style.display = 'none'; }, 8000);
    }

    async function api(url, method = 'GET', body) {
        const options = { method, headers: {} };
        if (body !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        const res = await fetch(url, options);
        let data = {};
        try { data = await res.json(); } catch (e) { /* пустой ответ */ }
        if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
        return data;
    }

    async function run(button, action) {
        const original = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Подождите...';
        try {
            await action();
        } catch (err) {
            showAlert('danger', err.message);
        } finally {
            button.disabled = false;
            button.innerHTML = original;
        }
    }

    function formatWhen(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    function fmtDuration(h) {
        h = Number(h) || 24;
        if (h >= 24 && h % 24 === 0) return `${h / 24} дн.`;
        return `${h} ч`;
    }

    function channelName(id) {
        const c = channels.find(ch => ch.id === id);
        return c ? '#' + c.name : (id || '—');
    }

    function modal(id) {
        return bootstrap.Modal.getOrCreateInstance(el(id));
    }

    // ---------- Вкладки ----------

    function showTab(name) {
        document.querySelectorAll('.pl-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
        document.querySelectorAll('.pl-pane').forEach(p => p.classList.toggle('active', p.id === 'plPane_' + name));
        if (name === 'suggestions') loadSuggestions();
    }
    document.querySelectorAll('.pl-tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

    // ---------- Каналы и роли ----------

    function channelOptions(firstLabel) {
        return `<option value="">${escapeHtml(firstLabel)}</option>` +
            channels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
    }

    async function loadDirectories() {
        try {
            channels = await api(`/api/guilds/${guildId}/channels`);
        } catch (err) {
            channels = [];
            showAlert('danger', 'Не удалось загрузить каналы: ' + err.message);
        }
        try {
            roles = await api(`/api/guilds/${guildId}/roles`);
        } catch (err) {
            roles = [];
        }

        el('plChannel').innerHTML = channelOptions('-- Выберите канал --');
        el('plSugChannel').innerHTML = channelOptions('-- Не выбран --');
        el('plReviewChannel').innerHTML = channelOptions('-- Не выбран --');
        el('plPublishChannel').innerHTML = channelOptions('-- Не выбран --');
        el('plPingRole').innerHTML = '<option value="">Не упоминать</option><option value="everyone">@everyone</option>' +
            roles.map(r => `<option value="${r.id}">@${escapeHtml(r.name)}</option>`).join('');
        el('plApproverRole').innerHTML = '<option value="">Право «Управлять сервером»</option>' +
            roles.map(r => `<option value="${r.id}">@${escapeHtml(r.name)}</option>`).join('');
    }

    // ---------- Конструктор: варианты ----------

    function optionInputs() {
        return Array.from(optionsBox.querySelectorAll('.pl-opt'));
    }

    function updateOptionsMeta() {
        const count = optionInputs().length;
        el('plOptionsCount').textContent = `${count}/${LIM.max}`;
        el('plAddOptionBtn').disabled = count >= LIM.max;
        optionsBox.querySelectorAll('.pl-opt-del').forEach(b => { b.disabled = count <= LIM.min; });
    }

    function addOption(value = '', focus = false) {
        if (optionInputs().length >= LIM.max) return;
        const row = document.createElement('div');
        row.className = 'd-flex gap-2 mb-2';
        row.innerHTML = `
            <input type="text" class="form-control pl-opt" maxlength="${LIM.option}" placeholder="Вариант ответа">
            <button type="button" class="btn btn-outline-danger pl-opt-del" title="Удалить"><i class="bi bi-x-lg"></i></button>
        `;
        const input = row.querySelector('.pl-opt');
        input.value = value;
        input.addEventListener('input', renderPreview);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addOption('', true);
            }
        });
        row.querySelector('.pl-opt-del').addEventListener('click', () => {
            if (optionInputs().length <= LIM.min) return;
            row.remove();
            updateOptionsMeta();
            renderPreview();
        });
        optionsBox.appendChild(row);
        updateOptionsMeta();
        if (focus) input.focus();
        renderPreview();
    }

    function setOptions(list) {
        optionsBox.innerHTML = '';
        const items = (list && list.length ? list : ['', '']).slice(0, LIM.max);
        while (items.length < LIM.min) items.push('');
        items.forEach(v => addOption(v));
        updateOptionsMeta();
        renderPreview();
    }

    el('plAddOptionBtn').addEventListener('click', () => addOption('', true));

    // ---------- Конструктор: предпросмотр ----------

    function collectPoll() {
        return {
            question: el('plQuestion').value.trim(),
            options: optionInputs().map(i => i.value.trim()).filter(Boolean),
            duration: parseInt(el('plDuration').value, 10) || 24,
            multiselect: el('plMulti').checked,
            channelId: el('plChannel').value,
            pingRole: el('plPingRole').value
        };
    }

    function renderPreview() {
        el('plQuestionCount').textContent = `${el('plQuestion').value.length}/${LIM.question}`;
        const p = collectPoll();
        const opts = p.options.length ? p.options : ['Вариант 1', 'Вариант 2'];

        let ping = '';
        if (p.pingRole === 'everyone') ping = '<span class="pl-ping">@everyone</span>';
        else if (p.pingRole) {
            const r = roles.find(x => x.id === p.pingRole);
            ping = `<span class="pl-ping">@${escapeHtml(r ? r.name : 'роль')}</span>`;
        }

        el('plPreview').innerHTML = `
            <div class="d-flex align-items-start gap-3">
                <img src="https://cdn.discordapp.com/embed/avatars/0.png" class="rounded-circle" width="40" height="40" alt="">
                <div class="flex-grow-1" style="min-width:0;">
                    <div class="mb-1"><span class="fw-bold text-white small">Ticket Bot</span>
                        <span class="badge bg-primary ms-1" style="font-size:0.65rem;">БОТ</span></div>
                    ${ping ? `<div class="mb-2">${ping}</div>` : ''}
                    <div class="pl-poll">
                        <div class="pl-poll-q">${escapeHtml(p.question || 'Ваш вопрос...')}</div>
                        <div class="pl-poll-hint">${p.multiselect ? 'Выберите один или несколько ответов' : 'Выберите один ответ'}</div>
                        ${opts.map(o => `<div class="pl-poll-ans"><span class="pl-radio ${p.multiselect ? 'multi' : ''}"></span><span>${escapeHtml(o)}</span></div>`).join('')}
                        <div class="pl-poll-foot">
                            <span>0 голосов · Осталось ${escapeHtml(fmtDuration(p.duration))}</span>
                            <span class="pl-vote-btn">Проголосовать</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    ['plQuestion', 'plDuration', 'plMulti', 'plPingRole', 'plChannel'].forEach(id => {
        el(id).addEventListener('input', renderPreview);
        el(id).addEventListener('change', renderPreview);
    });
    document.querySelectorAll('.pl-preset').forEach(b => b.addEventListener('click', () => {
        el('plDuration').value = b.dataset.h;
        renderPreview();
    }));

    function fillBuilder(p) {
        el('plQuestion').value = p.question || '';
        setOptions(p.options || []);
        if (p.duration) el('plDuration').value = p.duration;
        el('plMulti').checked = !!p.multiselect;
        if (p.channelId && channels.some(c => c.id === p.channelId)) el('plChannel').value = p.channelId;
        el('plPingRole').value = p.pingRole || '';
        renderPreview();
    }

    function resetBuilder(defaults) {
        el('plQuestion').value = '';
        setOptions([]);
        if (defaults) {
            el('plDuration').value = defaults.defaultDuration || 24;
            el('plMulti').checked = !!defaults.defaultMultiselect;
        }
        renderPreview();
    }

    // ---------- Конструктор: действия ----------

    el('plSendBtn').addEventListener('click', () => {
        const p = collectPoll();
        if (!p.channelId) return showAlert('warning', 'Выберите канал для отправки');
        if (!p.question) return showAlert('warning', 'Введите вопрос');
        if (p.options.length < LIM.min) return showAlert('warning', 'Нужно минимум 2 варианта ответа');
        if (!confirm(`Отправить опрос в ${channelName(p.channelId)} прямо сейчас?`)) return;
        run(el('plSendBtn'), async () => {
            await api('/api/polls/send', 'POST', p);
            showAlert('success', 'Опрос отправлен в Discord!');
            await loadHistory();
        });
    });

    el('plScheduleBtn').addEventListener('click', () => {
        const when = el('plScheduleTime').value;
        if (!when) return showAlert('warning', 'Выберите дату и время отправки');
        run(el('plScheduleBtn'), async () => {
            await api('/api/polls/schedule', 'POST', { ...collectPoll(), sendAt: new Date(when).toISOString() });
            el('plScheduleTime').value = '';
            await loadScheduled();
            showAlert('success', 'Опрос запланирован');
        });
    });

    // Шаблоны
    async function loadTemplates() {
        try { templates = await api('/api/polls/templates'); } catch (err) { templates = []; }
        el('plTemplateSelect').innerHTML = '<option value="">-- Загрузить шаблон --</option>' +
            templates.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
    }

    el('plTemplateSelect').addEventListener('change', () => {
        const t = templates.find(x => x.id === el('plTemplateSelect').value);
        if (t) fillBuilder(t.payload || {});
    });

    el('plSaveTemplateBtn').addEventListener('click', () => {
        const name = prompt('Название шаблона:');
        if (!name || !name.trim()) return;
        run(el('plSaveTemplateBtn'), async () => {
            await api('/api/polls/templates', 'POST', { ...collectPoll(), name: name.trim() });
            await loadTemplates();
            showAlert('success', 'Шаблон сохранён');
        });
    });

    el('plDeleteTemplateBtn').addEventListener('click', () => {
        const id = el('plTemplateSelect').value;
        if (!id) return showAlert('warning', 'Сначала выберите шаблон в списке');
        if (!confirm('Удалить выбранный шаблон?')) return;
        run(el('plDeleteTemplateBtn'), async () => {
            await api(`/api/polls/templates/${encodeURIComponent(id)}/delete`, 'POST', {});
            await loadTemplates();
            showAlert('success', 'Шаблон удалён');
        });
    });

    // Запланированные
    async function loadScheduled() {
        const box = el('plScheduledList');
        try {
            const items = await api('/api/polls/scheduled');
            if (!items.length) {
                box.innerHTML = '<div class="text-muted small">Нет запланированных опросов</div>';
                return;
            }
            box.innerHTML = items.map(i => `
                <div class="pl-item d-flex align-items-center justify-content-between gap-2">
                    <div style="min-width:0;">
                        <div class="text-white small fw-semibold text-truncate">${escapeHtml(i.question)}</div>
                        <div class="text-muted small"><i class="bi bi-clock me-1"></i>${formatWhen(i.sendAt)} · ${escapeHtml(channelName(i.channelId))}</div>
                        ${i.status === 'failed' ? `<div class="small" style="color:#f87171;">Ошибка: ${escapeHtml(i.error || 'не удалось отправить')}</div>` : ''}
                    </div>
                    <button class="btn btn-sm btn-outline-danger flex-shrink-0 pl-cancel-scheduled" data-id="${escapeHtml(i.id)}" title="Отменить"><i class="bi bi-x-lg"></i></button>
                </div>
            `).join('');
        } catch (err) {
            box.innerHTML = '<div class="text-danger small">Не удалось загрузить список</div>';
        }
    }

    el('plScheduledList').addEventListener('click', async (e) => {
        const btn = e.target.closest('.pl-cancel-scheduled');
        if (!btn) return;
        if (!confirm('Отменить эту запланированную отправку?')) return;
        try {
            btn.disabled = true;
            await api(`/api/polls/scheduled/${encodeURIComponent(btn.dataset.id)}/cancel`, 'POST', {});
            await loadScheduled();
        } catch (err) {
            showAlert('danger', err.message);
            btn.disabled = false;
        }
    });

    // История
    let history = [];
    async function loadHistory() {
        const box = el('plHistoryList');
        try {
            history = await api('/api/polls/history');
            if (!history.length) {
                box.innerHTML = '<div class="text-muted small">Пока ничего не отправлено</div>';
                return;
            }
            box.innerHTML = history.slice(0, 8).map((h, idx) => `
                <div class="pl-item d-flex align-items-center justify-content-between gap-2">
                    <div style="min-width:0;">
                        <div class="text-white small fw-semibold text-truncate">${escapeHtml(h.question)}</div>
                        <div class="text-muted small">${formatWhen(h.sentAt)} · ${escapeHtml(channelName(h.channelId))} · ${h.options.length} вар.</div>
                    </div>
                    <button class="btn btn-sm btn-outline-light flex-shrink-0 pl-duplicate" data-idx="${idx}" title="Скопировать в конструктор"><i class="bi bi-copy me-1"></i>Дублировать</button>
                </div>
            `).join('');
        } catch (err) {
            box.innerHTML = '<div class="text-danger small">Не удалось загрузить историю</div>';
        }
    }

    el('plHistoryList').addEventListener('click', (e) => {
        const btn = e.target.closest('.pl-duplicate');
        if (!btn) return;
        const h = history[parseInt(btn.dataset.idx, 10)];
        if (!h) return;
        fillBuilder(h);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        showAlert('info', 'Опрос скопирован в конструктор — можно править и отправлять.');
    });

    // ---------- Предложения ----------

    const STATUS = {
        pending: { label: 'Ждёт решения', cls: 'bg-warning text-dark' },
        approved: { label: 'Одобрено', cls: 'bg-success' },
        rejected: { label: 'Отклонено', cls: 'bg-danger' }
    };

    function updateCounts(c) {
        if (!c) return;
        el('plCntAll').textContent = c.total;
        el('plCntPending').textContent = c.pending;
        el('plCntApproved').textContent = c.approved;
        el('plCntRejected').textContent = c.rejected;
        const badge = el('plPendingBadge');
        badge.textContent = c.pending;
        badge.style.display = c.pending ? 'inline-block' : 'none';
    }

    function renderSuggestions() {
        const box = el('plSuggestions');
        el('plSuggestionsEmpty').style.display = suggestions.length ? 'none' : 'block';
        box.innerHTML = suggestions.map(s => {
            const st = STATUS[s.status] || STATUS.pending;
            const pending = s.status === 'pending';
            let decision = '';
            if (s.status === 'approved') {
                decision = `<div class="small text-muted mt-2">Одобрил: ${escapeHtml(s.decidedByName || '—')} · ${formatWhen(s.decidedAt)} · ${escapeHtml(channelName(s.publishedChannelId))}</div>`;
            } else if (s.status === 'rejected') {
                decision = `<div class="small text-muted mt-2">Отклонил: ${escapeHtml(s.decidedByName || '—')} · ${formatWhen(s.decidedAt)}${s.rejectionReason ? ` · Причина: ${escapeHtml(s.rejectionReason)}` : ''}</div>`;
            }
            return `
                <div class="pl-card" data-id="${escapeHtml(s.id)}">
                    <div class="d-flex justify-content-between align-items-start gap-2 flex-wrap">
                        <div style="min-width:0;">
                            <div class="fw-bold text-white">${escapeHtml(s.question)}</div>
                            <div class="text-muted small">Предложил <span class="text-white">${escapeHtml(s.authorName || s.authorId)}</span> · ${formatWhen(s.createdAt)}</div>
                        </div>
                        <span class="badge ${st.cls}">${st.label}</span>
                    </div>
                    ${s.duplicateOf && pending ? '<div class="small mt-2" style="color:#fbbf24;"><i class="bi bi-exclamation-triangle me-1"></i>Возможный дубль: такой вопрос уже предлагали.</div>' : ''}
                    <ul class="pl-sug-opts">${s.options.map(o => `<li>${escapeHtml(o)}</li>`).join('')}</ul>
                    ${decision}
                    <div class="d-flex gap-2 flex-wrap mt-3">
                        ${pending ? `
                            <button class="btn btn-sm btn-success pl-act" data-act="approve"><i class="bi bi-check-lg me-1"></i>Одобрить</button>
                            <button class="btn btn-sm btn-danger pl-act" data-act="reject"><i class="bi bi-x-lg me-1"></i>Отклонить</button>
                            <button class="btn btn-sm btn-outline-light pl-act" data-act="edit"><i class="bi bi-pencil me-1"></i>Редактировать</button>
                        ` : `
                            <button class="btn btn-sm btn-outline-light pl-act" data-act="copy"><i class="bi bi-copy me-1"></i>В конструктор</button>
                            <button class="btn btn-sm btn-outline-danger pl-act" data-act="delete"><i class="bi bi-trash me-1"></i>Удалить</button>
                        `}
                    </div>
                </div>
            `;
        }).join('');
    }

    async function loadSuggestions() {
        try {
            const q = filter === 'all' ? '' : `?status=${filter}`;
            const data = await api('/api/polls/suggestions' + q);
            suggestions = data.items || [];
            updateCounts(data.counts);
            renderSuggestions();
        } catch (err) {
            showAlert('danger', 'Не удалось загрузить предложения: ' + err.message);
        }
    }

    document.querySelectorAll('.pl-filter').forEach(b => b.addEventListener('click', () => {
        filter = b.dataset.filter;
        document.querySelectorAll('.pl-filter').forEach(x => x.classList.toggle('active', x === b));
        loadSuggestions();
    }));

    el('plSuggestions').addEventListener('click', async (e) => {
        const btn = e.target.closest('.pl-act');
        if (!btn) return;
        const id = btn.closest('[data-id]').dataset.id;
        const s = suggestions.find(x => x.id === id);
        if (!s) return;
        currentSuggestion = s;

        switch (btn.dataset.act) {
            case 'approve': {
                const def = el('plPublishChannel').value;
                el('plApproveQuestion').textContent = s.question;
                el('plApproveChannel').innerHTML =
                    `<option value="">${def ? 'По умолчанию (' + escapeHtml(channelName(def)) + ')' : '-- Выберите канал --'}</option>` +
                    channels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
                modal('plApproveModal').show();
                break;
            }
            case 'reject':
                el('plRejectQuestion').textContent = s.question;
                el('plRejectReason').value = '';
                modal('plRejectModal').show();
                break;
            case 'edit':
                el('plEditQuestion').value = s.question;
                el('plEditOptions').value = s.options.join('\n');
                modal('plEditModal').show();
                break;
            case 'copy':
                fillBuilder(s);
                showTab('builder');
                window.scrollTo({ top: 0, behavior: 'smooth' });
                break;
            case 'delete':
                if (!confirm('Удалить это предложение из списка?')) return;
                try {
                    await api(`/api/polls/suggestions/${encodeURIComponent(id)}/delete`, 'POST', {});
                    await loadSuggestions();
                } catch (err) {
                    showAlert('danger', err.message);
                }
                break;
        }
    });

    el('plApproveConfirm').addEventListener('click', () => {
        if (!currentSuggestion) return;
        run(el('plApproveConfirm'), async () => {
            await api(`/api/polls/suggestions/${encodeURIComponent(currentSuggestion.id)}/approve`, 'POST',
                { channelId: el('plApproveChannel').value });
            modal('plApproveModal').hide();
            showAlert('success', 'Опрос опубликован, автору отправлено уведомление.');
            await loadSuggestions();
        });
    });

    el('plRejectConfirm').addEventListener('click', () => {
        if (!currentSuggestion) return;
        run(el('plRejectConfirm'), async () => {
            await api(`/api/polls/suggestions/${encodeURIComponent(currentSuggestion.id)}/reject`, 'POST',
                { reason: el('plRejectReason').value.trim() });
            modal('plRejectModal').hide();
            showAlert('success', 'Предложение отклонено, автору отправлено уведомление.');
            await loadSuggestions();
        });
    });

    el('plEditConfirm').addEventListener('click', () => {
        if (!currentSuggestion) return;
        run(el('plEditConfirm'), async () => {
            await api(`/api/polls/suggestions/${encodeURIComponent(currentSuggestion.id)}/edit`, 'POST', {
                question: el('plEditQuestion').value,
                options: el('plEditOptions').value.split(/\r?\n/)
            });
            modal('plEditModal').hide();
            showAlert('success', 'Предложение обновлено');
            await loadSuggestions();
        });
    });

    // ---------- Настройки ----------

    function renderFormPreview() {
        el('plFormPreviewBox').style.borderLeftColor = el('plFormColor').value;
        el('plFormPreviewTitle').textContent = el('plFormTitle').value;
        el('plFormPreviewDesc').textContent = el('plFormDesc').value;
        el('plFormPreviewBtn').textContent = '📊 ' + (el('plFormBtn').value || 'Предложить опрос');
    }
    ['plFormTitle', 'plFormDesc', 'plFormBtn', 'plFormColor'].forEach(id => el(id).addEventListener('input', renderFormPreview));

    function applySettings(s, formMessage) {
        el('plSugChannel').value = s.suggestionChannelId || '';
        el('plReviewChannel').value = s.reviewChannelId || '';
        el('plPublishChannel').value = s.publishChannelId || '';
        el('plApproverRole').value = s.approverRoleId || '';
        el('plCooldown').value = s.cooldownHours;
        el('plDefDuration').value = s.defaultDuration;
        el('plDefMulti').checked = !!s.defaultMultiselect;
        el('plFormTitle').value = s.formTitle;
        el('plFormDesc').value = s.formDescription;
        el('plFormBtn').value = s.formButtonText;
        el('plFormColor').value = s.formColor;
        el('plDmSubmitOn').checked = !!s.dmOnSubmit;
        el('plDmApproveOn').checked = !!s.dmOnApprove;
        el('plDmRejectOn').checked = !!s.dmOnReject;
        el('plDmSubmitText').value = s.dmSubmitText;
        el('plDmApproveText').value = s.dmApproveText;
        el('plDmRejectText').value = s.dmRejectText;
        renderFormPreview();

        el('plFormStatus').innerHTML = formMessage
            ? `<i class="bi bi-check-circle me-1"></i>Форма опубликована в ${escapeHtml(channelName(formMessage.channelId))}. Кнопка «Обновить» изменит существующее сообщение.`
            : '<i class="bi bi-info-circle me-1"></i>Форма ещё не опубликована в Discord.';
    }

    function collectSettings() {
        return {
            suggestionChannelId: el('plSugChannel').value,
            reviewChannelId: el('plReviewChannel').value,
            publishChannelId: el('plPublishChannel').value,
            approverRoleId: el('plApproverRole').value,
            cooldownHours: parseInt(el('plCooldown').value, 10),
            defaultDuration: parseInt(el('plDefDuration').value, 10),
            defaultMultiselect: el('plDefMulti').checked,
            formTitle: el('plFormTitle').value,
            formDescription: el('plFormDesc').value,
            formButtonText: el('plFormBtn').value,
            formColor: el('plFormColor').value,
            dmOnSubmit: el('plDmSubmitOn').checked,
            dmOnApprove: el('plDmApproveOn').checked,
            dmOnReject: el('plDmRejectOn').checked,
            dmSubmitText: el('plDmSubmitText').value,
            dmApproveText: el('plDmApproveText').value,
            dmRejectText: el('plDmRejectText').value
        };
    }

    async function loadSettings(initial) {
        const data = await api('/api/polls/settings');
        applySettings(data.settings, data.formMessage);
        updateCounts(data.counts);
        if (initial) resetBuilder(data.settings);
    }

    el('plSaveSettingsBtn').addEventListener('click', () => run(el('plSaveSettingsBtn'), async () => {
        const data = await api('/api/polls/settings', 'POST', collectSettings());
        applySettings(data.settings, (await api('/api/polls/settings')).formMessage);
        showAlert('success', 'Настройки сохранены');
    }));

    el('plPublishFormBtn').addEventListener('click', () => {
        if (!el('plSugChannel').value) return showAlert('warning', 'Сначала выберите канал для кнопки «Предложить опрос»');
        run(el('plPublishFormBtn'), async () => {
            // Сначала сохраняем текущие значения, чтобы в Discord ушли именно они
            await api('/api/polls/settings', 'POST', collectSettings());
            const res = await api('/api/polls/publish-form', 'POST', {});
            await loadSettings(false);
            showAlert('success', res.updated ? 'Сообщение с формой обновлено' : 'Форма опубликована в Discord');
        });
    });

    // ---------- Старт ----------

    (async () => {
        await loadDirectories();
        try {
            await loadSettings(true);
        } catch (err) {
            showAlert('danger', 'Не удалось загрузить настройки: ' + err.message);
            setOptions([]);
        }
        await Promise.all([loadTemplates(), loadScheduled(), loadHistory()]);
        const scheduleInput = el('plScheduleTime');
        const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
        scheduleInput.min = localNow.toISOString().slice(0, 16);
    })();

    // Автообновление: список предложений и счётчик (если не открыто окно решения)
    setInterval(async () => {
        if (document.querySelector('.pl-modal.show')) return;
        try {
            if (el('plPane_suggestions').classList.contains('active')) await loadSuggestions();
            else updateCounts((await api('/api/polls/settings')).counts);
            if (el('plPane_builder').classList.contains('active')) await loadScheduled();
        } catch (err) { /* не критично */ }
    }, 30 * 1000);
});