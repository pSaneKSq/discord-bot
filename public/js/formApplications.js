document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('formApplicationsPage');
    if (!page) return;

    const listEl = document.getElementById('formApplicationsList');
    const emptyEl = document.getElementById('formApplicationsEmpty');
    const searchInput = document.getElementById('appsSearchInput');
    const statusSelect = document.getElementById('statusFilterSelect');
    const exportBtn = document.getElementById('appsExportBtn');
    const periodSelect = document.getElementById('statsPeriodSelect');

    const userCache = new Map();
    let currentApps = [];

    async function resolveUser(userId) {
        if (!userId) return { username: '—', avatar: 'https://cdn.discordapp.com/embed/avatars/0.png' };
        if (userCache.has(userId)) return userCache.get(userId);

        try {
            const res = await fetch(`/api/discord/users/${userId}`);
            const data = await res.json();
            userCache.set(userId, data);
            return data;
        } catch (err) {
            const fallback = { username: userId, avatar: 'https://cdn.discordapp.com/embed/avatars/0.png' };
            userCache.set(userId, fallback);
            return fallback;
        }
    }

    function formatDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function formatDuration(minutes) {
        if (minutes === null || minutes === undefined) return '—';
        const total = Math.round(minutes);
        if (total < 1) return 'меньше минуты';
        if (total < 60) return `${total} мин`;
        const hours = Math.floor(total / 60);
        const restMinutes = total % 60;
        if (hours < 24) return restMinutes ? `${hours} ч ${restMinutes} мин` : `${hours} ч`;
        const days = Math.floor(hours / 24);
        const restHours = hours % 24;
        return restHours ? `${days} д ${restHours} ч` : `${days} д`;
    }

    function statusBadge(status) {
        if (status === 'accepted') return '<span class="badge" style="background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3);">✅ Принята</span>';
        if (status === 'rejected') return '<span class="badge" style="background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3);">❌ Отклонена</span>';
        return '<span class="badge" style="background: rgba(234,179,8,0.15); color: #fbbf24; border: 1px solid rgba(234,179,8,0.3);">⏳ На рассмотрении</span>';
    }

    // ==========================================
    // СТАТИСТИКА
    // ==========================================

    function setText(id, value) {
        const node = document.getElementById(id);
        if (node) node.textContent = value;
    }

    function renderDaily(daily) {
        const bars = document.getElementById('statsDailyBars');
        const labels = document.getElementById('statsDailyLabels');
        if (!bars || !labels) return;

        if (!daily.length) {
            bars.innerHTML = '';
            labels.innerHTML = '';
            return;
        }

        const max = Math.max(...daily.map(d => d.count), 1);
        bars.innerHTML = daily.map(d => {
            const height = d.count > 0 ? Math.max((d.count / max) * 100, 6) : 3;
            const cls = d.count > 0 ? 'daily-bar' : 'daily-bar empty';
            const label = `${d.day.slice(8, 10)}.${d.day.slice(5, 7)}: ${d.count}`;
            return `<div class="${cls}" style="height:${height}%;" title="${label}"></div>`;
        }).join('');

        const first = daily[0].day;
        const last = daily[daily.length - 1].day;
        labels.innerHTML = `<span>${first.slice(8, 10)}.${first.slice(5, 7)}</span><span>${last.slice(8, 10)}.${last.slice(5, 7)}</span>`;
    }

    async function renderModerators(moderators) {
        const box = document.getElementById('statsModerators');
        if (!box) return;

        if (!moderators.length) {
            box.innerHTML = '<span class="text-muted small">Пока нет принятых решений за этот период</span>';
            return;
        }

        const max = Math.max(...moderators.map(m => m.count), 1);
        const rows = await Promise.all(moderators.map(async (m) => {
            const user = await resolveUser(m.decided_by);
            return `
                <div class="d-flex align-items-center gap-2 mb-2">
                    <img src="${user.avatar}" class="rounded-circle flex-shrink-0" width="28" height="28">
                    <div class="flex-grow-1 overflow-hidden">
                        <div class="d-flex justify-content-between">
                            <span class="text-white small text-truncate">${escapeHtml(user.username)}</span>
                            <span class="text-muted small flex-shrink-0">${m.count}</span>
                        </div>
                        <div style="background: rgba(255,255,255,0.06); border-radius: 6px; height: 5px; overflow: hidden;">
                            <div style="width:${(m.count / max) * 100}%; height:100%; background: var(--accent-color);"></div>
                        </div>
                    </div>
                </div>
            `;
        }));
        box.innerHTML = rows.join('');
    }

    function renderPerForm(perForm) {
        const body = document.getElementById('statsPerForm');
        if (!body) return;

        if (!perForm.length) {
            body.innerHTML = '<tr><td colspan="6" class="text-muted">За этот период заявок не было</td></tr>';
            return;
        }

        body.innerHTML = perForm.map(f => `
            <tr>
                <td class="text-white fw-semibold">${escapeHtml(f.form_title || f.form_id)}</td>
                <td class="text-end">${f.total}</td>
                <td class="text-end" style="color:#4ade80;">${f.accepted}</td>
                <td class="text-end" style="color:#f87171;">${f.rejected}</td>
                <td class="text-end" style="color:#fbbf24;">${f.pending}</td>
                <td class="text-end">${formatDuration(f.avg_minutes)}</td>
            </tr>
        `).join('');
    }

    async function loadStats() {
        try {
            const res = await fetch(`/api/forms/applications/stats?days=${encodeURIComponent(periodSelect.value)}`);
            if (!res.ok) throw new Error('Ошибка загрузки статистики');
            const data = await res.json();

            const s = data.summary;
            setText('statAppsTotal', s.total);
            setText('statAppsPending', s.pending);
            setText('statAppsAccepted', s.accepted);
            setText('statAppsRejected', s.rejected);

            const decided = s.accepted + s.rejected;
            setText('statAppsRate', decided > 0 ? `${Math.round((s.accepted / decided) * 100)}%` : '—');
            setText('statAppsAvg', formatDuration(s.avgMinutes));

            renderDaily(data.daily || []);
            renderPerForm(data.perForm || []);
            await renderModerators(data.moderators || []);
        } catch (err) {
            console.error('Ошибка загрузки статистики заявок:', err);
        }
    }

    // ==========================================
    // ИСТОРИЯ ЗАЯВОК
    // ==========================================

    async function renderApps(apps) {
        if (!apps.length) {
            listEl.innerHTML = '';
            emptyEl.style.display = 'block';
            return;
        }
        emptyEl.style.display = 'none';

        const rowsHtml = await Promise.all(apps.map(async (app) => {
            const [applicant, decider, claimer] = await Promise.all([
                resolveUser(app.user_id),
                resolveUser(app.decided_by),
                resolveUser(app.claimed_by)
            ]);

            let answers = [];
            try {
                answers = Array.isArray(app.answers) ? app.answers : JSON.parse(app.answers || '[]');
            } catch (e) { answers = []; }

            const answersHtml = answers.map(a => `
                <div class="app-answer">
                    <div class="text-muted small">${escapeHtml(a.label)}</div>
                    <div class="text-light small">${escapeHtml(a.value)}</div>
                </div>
            `).join('');

            // Комментарии модераторов
            const notes = Array.isArray(app.notes) ? app.notes : [];
            const notesRows = await Promise.all(notes.map(async (n) => {
                const author = n.author_id
                    ? await resolveUser(n.author_id)
                    : { username: n.author_name || 'Модератор' };
                return `
                    <div class="app-answer">
                        <div class="text-muted small">${escapeHtml(author.username)} · ${formatDate(n.created_at)}</div>
                        <div class="text-light small" style="white-space: pre-wrap;">${escapeHtml(n.text)}</div>
                    </div>
                `;
            }));

            const notesHtml = `
                <div class="pt-2 mt-2 border-top border-secondary border-opacity-10">
                    <div class="text-muted small fw-semibold mb-1"><i class="bi bi-chat-left-text me-1"></i>Комментарии модераторов (${notes.length})</div>
                    ${notesRows.join('')}
                    <div class="d-flex gap-2 mt-2">
                        <input type="text" class="form-control form-control-sm note-input" data-app-id="${app.id}" maxlength="1000"
                            placeholder="Добавить комментарий..." style="background:#0f1015; border:1px solid rgba(255,255,255,0.1); color:#fff;">
                        <button type="button" class="btn btn-sm text-white note-add-btn flex-shrink-0" data-app-id="${app.id}"
                            style="background: var(--accent-color); border: none;">Добавить</button>
                    </div>
                </div>
            `;

            // Кто сейчас рассматривает заявку (только пока она ждёт решения)
            const claimBadge = (app.status === 'pending' && app.claimed_by)
                ? `<span class="badge" style="background: rgba(139,92,246,0.15); color: #c4b5fd; border: 1px solid rgba(139,92,246,0.3);">🙋 Рассматривает: ${escapeHtml(claimer.username)}</span>`
                : '';

            return `
                <div class="app-row">
                    <div class="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
                        <div class="d-flex align-items-center gap-2">
                            <span class="badge bg-secondary bg-opacity-25 text-light px-2 py-1">Заявка #${app.id}</span>
                            <span class="text-muted small">${escapeHtml(app.form_title || '')}</span>
                        </div>
                        <div class="d-flex align-items-center gap-2 flex-wrap">
                            ${claimBadge}
                            ${statusBadge(app.status)}
                        </div>
                    </div>

                    <div class="row g-3 mb-2">
                        <div class="col-md-5">
                            <div class="d-flex align-items-center gap-2">
                                <img src="${applicant.avatar}" class="rounded-circle app-avatar">
                                <div>
                                    <div class="text-muted small">Заявитель</div>
                                    <div class="text-white fw-semibold small">${escapeHtml(applicant.username)}</div>
                                </div>
                            </div>
                        </div>
                        <div class="col-md-5">
                            ${app.decided_by ? `
                                <div class="d-flex align-items-center gap-2">
                                    <img src="${decider.avatar}" class="rounded-circle app-avatar">
                                    <div>
                                        <div class="text-muted small">Решение принял</div>
                                        <div class="text-white fw-semibold small">${escapeHtml(decider.username)}</div>
                                    </div>
                                </div>
                            ` : `<div class="text-muted small">Решение ещё не принято</div>`}
                        </div>
                        <div class="col-md-2 text-md-end">
                            <div class="text-muted small">Подана</div>
                            <div class="text-white small">${formatDate(app.created_at)}</div>
                        </div>
                    </div>

                    ${answersHtml ? `<div class="pt-2 border-top border-secondary border-opacity-10">${answersHtml}</div>` : ''}
                    ${notesHtml}
                </div>
            `;
        }));

        listEl.innerHTML = rowsHtml.join('');
    }

    async function loadApps() {
        try {
            const params = new URLSearchParams();
            if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
            if (statusSelect.value) params.set('status', statusSelect.value);

            const res = await fetch(`/api/forms/applications?${params.toString()}`);
            currentApps = await res.json();
            renderApps(currentApps);
        } catch (err) {
            console.error('Ошибка загрузки истории заявок:', err);
        }
    }

    // Добавление комментария к заявке с сайта
    async function addNote(appId, input, button) {
        const text = input.value.trim();
        if (!text) return;

        button.disabled = true;
        try {
            const res = await fetch(`/api/forms/applications/${appId}/notes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                alert('Не удалось сохранить комментарий: ' + (data.error || 'неизвестная ошибка'));
                button.disabled = false;
                return;
            }
            await loadApps();
        } catch (err) {
            console.error(err);
            alert('Ошибка соединения с сервером');
            button.disabled = false;
        }
    }

    listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.note-add-btn');
        if (!btn) return;
        const input = listEl.querySelector(`.note-input[data-app-id="${btn.dataset.appId}"]`);
        if (input) addNote(btn.dataset.appId, input, btn);
    });

    listEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const input = e.target.closest('.note-input');
        if (!input) return;
        e.preventDefault();
        const btn = listEl.querySelector(`.note-add-btn[data-app-id="${input.dataset.appId}"]`);
        if (btn) addNote(input.dataset.appId, input, btn);
    });

    let searchTimeout = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(loadApps, 300);
    });
    statusSelect.addEventListener('change', loadApps);
    periodSelect.addEventListener('change', loadStats);

    exportBtn.addEventListener('click', () => {
        if (!currentApps.length) return;
        const headers = ['ID заявки', 'Форма', 'ID заявителя', 'Статус', 'ID решившего', 'Подана', 'Решена'];
        const rows = currentApps.map(a => [a.id, a.form_title, a.user_id, a.status, a.decided_by, a.created_at, a.decided_at]);
        const csvLines = [headers.join(',')];
        rows.forEach(row => csvLines.push(row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
        const blob = new Blob(['\uFEFF' + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'form_applications.csv';
        a.click();
        URL.revokeObjectURL(url);
    });

    loadStats();
    loadApps();
});