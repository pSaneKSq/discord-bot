document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('memberProfilePage');
    if (!page) return;

    const searchInput = document.getElementById('mpSearchInput');
    const resultsEl = document.getElementById('mpSearchResults');
    const emptyEl = document.getElementById('mpEmpty');
    const loadingEl = document.getElementById('mpLoading');
    const errorEl = document.getElementById('mpError');
    const contentEl = document.getElementById('mpContent');

    const DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

    const LOG_META = {
        warn: { icon: '⚠️', label: 'Предупреждение' },
        member_join: { icon: '📥', label: 'Вход участника' },
        member_leave: { icon: '📤', label: 'Выход участника' },
        sostav_call: { icon: '🚨', label: 'Созыв состава' },
        form_decision: { icon: '📝', label: 'Решение по заявке' },
        automod: { icon: '🤖', label: 'Автомодерация' },
        message_edit: { icon: '✏️', label: 'Правка сообщения' },
        message_delete: { icon: '🗑️', label: 'Удаление сообщения' },
        other: { icon: 'ℹ️', label: 'Событие' }
    };

    let currentId = null;
    let data = null;
    let searchTimeout = null;
    let searchSeq = 0;
    let activeIndex = -1;
    let lastResults = [];

    // ==========================================
    // Форматирование
    // ==========================================

    function formatDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function formatDay(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    function ago(iso) {
        if (!iso) return '';
        const diff = Date.now() - new Date(iso).getTime();
        if (diff < 0) return '';
        const min = Math.floor(diff / 60000);
        if (min < 1) return 'только что';
        if (min < 60) return `${min} мин назад`;
        const hours = Math.floor(min / 60);
        if (hours < 24) return `${hours} ч назад`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days} дн назад`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months} мес назад`;
        return `${Math.floor(days / 365)} г назад`;
    }

    function formatVoice(seconds) {
        const total = Number(seconds) || 0;
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        if (hours > 0) return `${hours} ч ${minutes} мин`;
        if (minutes > 0) return `${minutes} мин`;
        return '0';
    }

    function userOf(id) {
        return (data && data.users && data.users[id]) || { username: id || '—', avatar: DEFAULT_AVATAR };
    }

    function userChip(id, fallbackName) {
        if (!id) return `<span class="small">${escapeHtml(fallbackName || '—')}</span>`;
        const u = userOf(id);
        return `<span class="d-inline-flex align-items-center gap-1">
            <img src="${escapeHtml(u.avatar)}" class="mp-mini-avatar" alt="">
            <span class="small">${escapeHtml(u.username)}</span>
        </span>`;
    }

    function showOnly(state) {
        emptyEl.style.display = state === 'empty' ? 'block' : 'none';
        loadingEl.style.display = state === 'loading' ? 'block' : 'none';
        contentEl.style.display = state === 'content' ? 'block' : 'none';
        if (state !== 'error') errorEl.style.display = 'none';
    }

    function showError(text) {
        errorEl.textContent = text;
        errorEl.style.display = 'block';
        loadingEl.style.display = 'none';
        contentEl.style.display = 'none';
        emptyEl.style.display = 'none';
    }

    // ==========================================
    // Поиск
    // ==========================================

    function hideResults() {
        resultsEl.style.display = 'none';
        resultsEl.innerHTML = '';
        activeIndex = -1;
    }

    function renderResults(list) {
        lastResults = list;
        activeIndex = -1;
        if (!list.length) {
            resultsEl.innerHTML = '<div class="p-3 text-muted small">Никого не найдено. Попробуйте полный Discord ID.</div>';
            resultsEl.style.display = 'block';
            return;
        }
        resultsEl.innerHTML = list.map((m, i) => `
            <div class="mp-result-item" data-index="${i}" data-id="${escapeHtml(m.id)}">
                <img src="${escapeHtml(m.avatar)}" class="rounded-circle" width="32" height="32" alt="">
                <div class="flex-grow-1 overflow-hidden">
                    <div class="text-white small fw-semibold text-truncate">${escapeHtml(m.displayName || m.username)}</div>
                    <div class="text-muted small text-truncate">${escapeHtml(m.username)} · ${escapeHtml(m.id)}</div>
                </div>
                ${m.inServer ? '' : '<span class="mp-badge mp-badge-gray">не на сервере</span>'}
                ${m.bot ? '<span class="mp-badge mp-badge-blue">бот</span>' : ''}
            </div>
        `).join('');
        resultsEl.style.display = 'block';
    }

    function highlightActive() {
        resultsEl.querySelectorAll('.mp-result-item').forEach((el, i) => {
            el.classList.toggle('active', i === activeIndex);
        });
    }

    async function runSearch() {
        const q = searchInput.value.trim();
        if (q.length < 2) {
            hideResults();
            return;
        }
        const seq = ++searchSeq;
        try {
            const res = await fetch(`/api/members/search?q=${encodeURIComponent(q)}`);
            const list = await res.json();
            if (seq !== searchSeq) return; // пришёл устаревший ответ
            if (!res.ok) throw new Error(list.error || 'Ошибка поиска');
            renderResults(Array.isArray(list) ? list : []);
        } catch (err) {
            if (seq !== searchSeq) return;
            resultsEl.innerHTML = `<div class="p-3 text-danger small">${escapeHtml(err.message)}</div>`;
            resultsEl.style.display = 'block';
        }
    }

    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(runSearch, 300);
    });

    searchInput.addEventListener('keydown', (e) => {
        const items = resultsEl.querySelectorAll('.mp-result-item');
        if (e.key === 'ArrowDown' && items.length) {
            e.preventDefault();
            activeIndex = (activeIndex + 1) % items.length;
            highlightActive();
        } else if (e.key === 'ArrowUp' && items.length) {
            e.preventDefault();
            activeIndex = (activeIndex - 1 + items.length) % items.length;
            highlightActive();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const q = searchInput.value.trim();
            if (activeIndex >= 0 && lastResults[activeIndex]) {
                pick(lastResults[activeIndex].id);
            } else if (/^\d{15,25}$/.test(q)) {
                pick(q);
            } else if (lastResults.length) {
                pick(lastResults[0].id);
            }
        } else if (e.key === 'Escape') {
            hideResults();
        }
    });

    resultsEl.addEventListener('click', (e) => {
        const item = e.target.closest('.mp-result-item');
        if (item) pick(item.dataset.id);
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.mp-search-wrap')) hideResults();
    });

    function pick(id) {
        hideResults();
        searchInput.value = '';
        loadProfile(id);
    }

    // ==========================================
    // Отрисовка секций
    // ==========================================

    function renderHeader(d) {
        const u = d.user;
        const m = d.member;
        const ms = d.membership;

        const badges = [];
        badges.push(m
            ? '<span class="mp-badge mp-badge-green">🟢 На сервере</span>'
            : '<span class="mp-badge mp-badge-gray">⚪ Не на сервере</span>');
        if (u.bot) badges.push('<span class="mp-badge mp-badge-blue">🤖 Бот</span>');
        if (m && m.timeoutUntil) badges.push(`<span class="mp-badge mp-badge-yellow">🔇 В таймауте до ${formatDate(m.timeoutUntil)}</span>`);
        if (d.warnings.active > 0) badges.push(`<span class="mp-badge mp-badge-red">⚠️ Активных варнов: ${d.warnings.active}</span>`);
        if (!u.found) badges.push('<span class="mp-badge mp-badge-gray">Пользователь не найден в Discord</span>');

        const roles = m && m.roles.length
            ? m.roles.map(r => `
                <span class="mp-role">
                    <span class="mp-role-dot" style="background:${escapeHtml(r.color && r.color !== '#000000' ? r.color : '#9ca3af')};"></span>
                    ${escapeHtml(r.name)}
                </span>`).join('')
            : '<span class="text-muted small">Ролей нет</span>';

        const display = (m && m.displayName) || u.globalName || u.username;

        return `
            <div class="mp-card mb-3">
                <div class="d-flex gap-3 flex-wrap">
                    <img src="${escapeHtml(u.avatar)}" class="mp-avatar-lg" alt="">
                    <div class="flex-grow-1" style="min-width:260px;">
                        <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                            <div>
                                <div class="text-white fw-bold fs-4">${escapeHtml(display)}</div>
                                <div class="text-muted small">
                                    @${escapeHtml(u.username)} · <span id="mpIdText">${escapeHtml(u.id)}</span>
                                    <button type="button" class="mp-copy-btn" data-action="copy-id" title="Скопировать ID"><i class="bi bi-clipboard"></i></button>
                                </div>
                            </div>
                            <button type="button" class="btn btn-sm btn-outline-light" data-action="refresh"><i class="bi bi-arrow-clockwise me-1"></i>Обновить</button>
                        </div>
                        <div class="d-flex flex-wrap gap-2 mt-2">${badges.join('')}</div>
                    </div>
                </div>

                <div class="row g-3 mt-1">
                    <div class="col-md-3 col-6">
                        <div class="mp-stat">
                            <div class="text-muted small">Аккаунт создан</div>
                            <div class="text-white small fw-semibold">${formatDay(u.createdAt)}</div>
                            <div class="text-muted small">${ago(u.createdAt)}</div>
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="mp-stat">
                            <div class="text-muted small">Вошёл на сервер</div>
                            <div class="text-white small fw-semibold">${m ? formatDay(m.joinedAt) : '—'}</div>
                            <div class="text-muted small">${m ? ago(m.joinedAt) : 'сейчас не на сервере'}</div>
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="mp-stat">
                            <div class="text-muted small">Впервые замечен ботом</div>
                            <div class="text-white small fw-semibold">${formatDay(ms.firstSeen)}</div>
                            <div class="text-muted small">${ago(ms.firstSeen)}</div>
                        </div>
                    </div>
                    <div class="col-md-3 col-6">
                        <div class="mp-stat">
                            <div class="text-muted small">Входов / выходов</div>
                            <div class="text-white small fw-semibold">${ms.joins} / ${ms.leaves}</div>
                            <div class="text-muted small">по данным бота</div>
                        </div>
                    </div>
                </div>

                <div class="mt-3">
                    <div class="text-muted small fw-semibold mb-2">Роли</div>
                    <div class="d-flex flex-wrap gap-2">${roles}</div>
                </div>
            </div>
        `;
    }

    function renderSummary(d) {
        const apps = d.applications;
        const accepted = apps.filter(a => a.status === 'accepted').length;
        const rejected = apps.filter(a => a.status === 'rejected').length;
        const pending = apps.filter(a => a.status === 'pending').length;
        const msg = d.activity.messages;
        const voice = d.activity.voice;
        const swears = d.swears || { count: 0, unique_words: 0 };

        return `
            <div class="row g-3 mb-3">
                <div class="col-xl col-md-4 col-6"><div class="mp-stat">
                    <div class="text-muted small">Активные варны</div>
                    <div class="fw-bold fs-4" style="color:${d.warnings.active ? '#f87171' : '#4ade80'};">${d.warnings.active}</div>
                    <div class="text-muted small">всего выдано: ${d.warnings.total}</div>
                </div></div>
                <div class="col-xl col-md-4 col-6"><div class="mp-stat">
                    <div class="text-muted small">Заявки</div>
                    <div class="text-white fw-bold fs-4">${apps.length}</div>
                    <div class="text-muted small">✅ ${accepted} · ❌ ${rejected} · ⏳ ${pending}</div>
                </div></div>
                <div class="col-xl col-md-4 col-6"><div class="mp-stat">
                    <div class="text-muted small">Сообщений за 30 дн</div>
                    <div class="text-white fw-bold fs-4">${msg ? msg.d30 : '—'}</div>
                    <div class="text-muted small">за 7 дн: ${msg ? msg.d7 : '—'}</div>
                </div></div>
                <div class="col-xl col-md-4 col-6"><div class="mp-stat">
                    <div class="text-muted small">Войс за 30 дн</div>
                    <div class="text-white fw-bold fs-4">${voice ? formatVoice(voice.s30) : '—'}</div>
                    <div class="text-muted small">за 7 дн: ${voice ? formatVoice(voice.s7) : '—'}</div>
                </div></div>
                <div class="col-xl col-md-4 col-6"><div class="mp-stat">
                    <div class="text-muted small">Матов за 30 дн</div>
                    <div class="text-white fw-bold fs-4">${swears.count}</div>
                    <div class="text-muted small">уникальных слов: ${swears.unique_words}</div>
                </div></div>
                <div class="col-xl col-md-4 col-6"><div class="mp-stat">
                    <div class="text-muted small">Заметок</div>
                    <div class="text-white fw-bold fs-4">${d.notes.length}</div>
                    <div class="text-muted small">от модераторов</div>
                </div></div>
            </div>
        `;
    }

    function warnBadge(state, expiresAt) {
        if (state === 'permanent') return '<span class="mp-badge mp-badge-accent">♾️ Бессрочно</span>';
        if (state === 'active') return `<span class="mp-badge mp-badge-yellow">⏳ До ${formatDay(expiresAt)}</span>`;
        return '<span class="mp-badge mp-badge-gray">✔️ Истекло</span>';
    }

    function renderWarnings(d) {
        const items = d.warnings.items;
        const body = items.length ? items.map(w => `
            <div class="mp-row mb-2">
                <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                    <div class="text-white small fw-semibold">${escapeHtml(w.reason)}</div>
                    ${warnBadge(w.state, w.expiresAt)}
                </div>
                <div class="d-flex align-items-center gap-3 flex-wrap mt-1">
                    <span class="text-muted small">Выдал:</span> ${userChip(w.moderatorId)}
                    <span class="text-muted small">${formatDate(w.createdAt)}</span>
                </div>
            </div>
        `).join('') : '<div class="text-muted small">Предупреждений нет.</div>';

        return `
            <div class="mp-card mb-3">
                <h6 class="text-white fw-bold"><i class="bi bi-exclamation-triangle text-accent me-2"></i>Предупреждения
                    <span class="text-muted fw-normal small">(${d.warnings.active} активных из ${d.warnings.total})</span></h6>
                ${body}
            </div>
        `;
    }

    function appStatusBadge(status) {
        if (status === 'accepted') return '<span class="mp-badge mp-badge-green">✅ Принята</span>';
        if (status === 'rejected') return '<span class="mp-badge mp-badge-red">❌ Отклонена</span>';
        return '<span class="mp-badge mp-badge-yellow">⏳ На рассмотрении</span>';
    }

    function renderApplications(d) {
        const body = d.applications.length ? d.applications.map(a => {
            const notes = a.notes.length ? `
                <details class="mp-details mt-2">
                    <summary class="text-muted small"><i class="bi bi-chat-left-text me-1"></i>Комментарии модераторов (${a.notes.length})</summary>
                    ${a.notes.map(n => `
                        <div class="mp-row mt-2">
                            <div class="text-muted small">${escapeHtml(n.authorId ? userOf(n.authorId).username : n.authorName)} · ${formatDate(n.createdAt)}</div>
                            <div class="text-light small" style="white-space:pre-wrap;">${escapeHtml(n.text)}</div>
                        </div>`).join('')}
                </details>` : '';

            const decision = a.decidedBy
                ? `<span class="text-muted small">Решил:</span> ${userChip(a.decidedBy)} <span class="text-muted small">${formatDate(a.decidedAt)}</span>`
                : (a.status === 'pending' && a.claimedBy
                    ? `<span class="text-muted small">Рассматривает:</span> ${userChip(a.claimedBy)}`
                    : '<span class="text-muted small">Решение ещё не принято</span>');

            return `
                <div class="mp-row mb-2">
                    <div class="d-flex align-items-center justify-content-between flex-wrap gap-2">
                        <div class="text-white small fw-semibold">#${a.id} · ${escapeHtml(a.formTitle || '')}</div>
                        ${appStatusBadge(a.status)}
                    </div>
                    <div class="d-flex align-items-center gap-3 flex-wrap mt-1">
                        <span class="text-muted small">Подана ${formatDate(a.createdAt)}</span>
                        ${decision}
                    </div>
                    ${notes}
                </div>`;
        }).join('') : '<div class="text-muted small">Заявок не подавал(а).</div>';

        return `
            <div class="mp-card mb-3">
                <h6 class="text-white fw-bold"><i class="bi bi-clipboard-data text-accent me-2"></i>Заявки
                    <span class="text-muted fw-normal small">(${d.applications.length})</span></h6>
                ${body}
            </div>
        `;
    }

    function renderActivity(d) {
        const a = d.activity;
        const msg = a.messages;
        const voice = a.voice;

        let bars = '<div class="text-muted small">Нет данных.</div>';
        if (a.daily && a.daily.length) {
            const max = Math.max(...a.daily.map(x => x.count), 1);
            const barsHtml = a.daily.map((x) => {
                const height = x.count > 0 ? Math.max((x.count / max) * 100, 6) : 3;
                const title = `${x.day.slice(8, 10)}.${x.day.slice(5, 7)}: ${x.count}`;
                return `<div class="mp-bar ${x.count > 0 ? '' : 'empty'}" style="height:${height}%;" title="${title}"></div>`;
            }).join('');
            const first = a.daily[0].day;
            const last = a.daily[a.daily.length - 1].day;
            bars = `<div class="mp-bars">${barsHtml}</div>
                    <div class="mp-bars-labels"><span>${first.slice(8, 10)}.${first.slice(5, 7)}</span><span>${last.slice(8, 10)}.${last.slice(5, 7)}</span></div>`;
        }

        let channels = '<div class="text-muted small">Нет сообщений за 30 дней.</div>';
        if (a.topChannels && a.topChannels.length) {
            const max = Math.max(...a.topChannels.map(c => c.value), 1);
            channels = a.topChannels.map(c => `
                <div class="mb-2">
                    <div class="d-flex justify-content-between">
                        <span class="text-white small text-truncate">#${escapeHtml(c.name)}</span>
                        <span class="text-muted small flex-shrink-0">${c.value}</span>
                    </div>
                    <div style="background:rgba(255,255,255,0.06); border-radius:6px; height:5px; overflow:hidden;">
                        <div style="width:${(c.value / max) * 100}%; height:100%; background:var(--accent-color);"></div>
                    </div>
                </div>`).join('');
        }

        return `
            <div class="mp-card mb-3">
                <h6 class="text-white fw-bold"><i class="bi bi-activity text-accent me-2"></i>Активность
                    <span class="text-muted fw-normal small">(бот хранит данные не дольше 90 дней)</span></h6>
                <div class="row g-2 mb-3">
                    <div class="col-6"><div class="mp-stat">
                        <div class="text-muted small">Сообщения 7 / 30 / 90 дн</div>
                        <div class="text-white small fw-semibold">${msg ? `${msg.d7} / ${msg.d30} / ${msg.d90}` : '—'}</div>
                        <div class="text-muted small">последнее: ${msg && msg.last ? ago(msg.last) : 'нет'}</div>
                    </div></div>
                    <div class="col-6"><div class="mp-stat">
                        <div class="text-muted small">Войс 7 / 30 / 90 дн</div>
                        <div class="text-white small fw-semibold">${voice ? `${formatVoice(voice.s7)} / ${formatVoice(voice.s30)} / ${formatVoice(voice.s90)}` : '—'}</div>
                        <div class="text-muted small">последний: ${voice && voice.last ? ago(voice.last) : 'нет'}</div>
                    </div></div>
                </div>
                <div class="text-muted small fw-semibold mb-1">Сообщения по дням (30 дней)</div>
                ${bars}
                <div class="text-muted small fw-semibold mt-3 mb-2">Любимые каналы (30 дней)</div>
                ${channels}
            </div>
        `;
    }

    function renderMembership(d) {
        const h = d.membership.history;
        const body = h.length ? h.map(e => `
            <div class="d-flex align-items-center justify-content-between py-1 border-bottom border-secondary border-opacity-10">
                <span class="small">${e.type === 'join' ? '📥 Вход' : '📤 Выход'}</span>
                <span class="text-muted small">${formatDate(e.at)} · ${ago(e.at)}</span>
            </div>`).join('') : '<div class="text-muted small">Событий входа/выхода в базе нет.</div>';

        return `
            <div class="mp-card mb-3">
                <h6 class="text-white fw-bold"><i class="bi bi-door-open text-accent me-2"></i>История входов и выходов</h6>
                ${body}
            </div>
        `;
    }

    function renderNotes(d) {
        const list = d.notes.length ? d.notes.map(n => `
            <div class="mp-row mb-2">
                <div class="d-flex align-items-center justify-content-between gap-2">
                    <div class="text-muted small">${escapeHtml(n.authorId ? userOf(n.authorId).username : n.authorName)} · ${formatDate(n.createdAt)}</div>
                    ${n.canDelete ? `<button type="button" class="btn btn-sm btn-outline-danger py-0 px-2" data-action="delete-note" data-note-id="${n.id}" title="Удалить заметку"><i class="bi bi-trash"></i></button>` : ''}
                </div>
                <div class="text-light small" style="white-space:pre-wrap;">${escapeHtml(n.text)}</div>
            </div>`).join('') : '<div class="text-muted small mb-2">Заметок пока нет.</div>';

        return `
            <div class="mp-card mb-3">
                <h6 class="text-white fw-bold"><i class="bi bi-sticky text-accent me-2"></i>Заметки модераторов
                    <span class="text-muted fw-normal small">(${d.notes.length})</span></h6>
                <div class="mb-3">
                    <textarea class="form-control form-control-sm" id="mpNoteInput" rows="2" maxlength="1000"
                        placeholder="Добавить заметку об участнике..."
                        style="background:#0f1015; border:1px solid rgba(255,255,255,0.1); color:#fff;"></textarea>
                    <div class="d-flex justify-content-between align-items-center mt-2">
                        <span class="text-muted small">Видна всем модераторам панели. Удалить может автор или владелец.</span>
                        <button type="button" class="btn btn-sm text-white" id="mpNoteAddBtn" data-action="add-note"
                            style="background:var(--accent-color); border:none;">Добавить</button>
                    </div>
                </div>
                ${list}
            </div>
        `;
    }

    function renderLevel(d) {
        const level = d.level;
        if (!level) {
            return `
                <div class="mp-card mb-3">
                    <h6 class="text-white fw-bold"><i class="bi bi-trophy text-accent me-2"></i>Уровень и XP</h6>
                    <div class="text-muted small">Нет данных об уровне пользователя.</div>
                </div>
            `;
        }

        const progress = level.progress;
        const progressPercentage = progress && progress.percentage !== undefined ? progress.percentage.toFixed(1) : 0;
        const xpToNext = progress && progress.toNextLevel !== undefined ? progress.toNextLevel.toLocaleString() : '—';
        const xpInCurrent = progress && progress.current !== undefined ? progress.current.toLocaleString() : 0;
        const xpNeeded = progress && progress.needed !== undefined ? progress.needed.toLocaleString() : '—';

        const levelValue = level.level !== undefined ? level.level : 0;
        const xpValue = level.xp !== undefined ? level.xp.toLocaleString() : '0';
        const totalMessages = level.totalMessages !== undefined ? level.totalMessages.toLocaleString() : '0';
        const levelUpCount = level.levelUpCount !== undefined ? level.levelUpCount : 0;

        return `
            <div class="mp-card mb-3">
                <h6 class="text-white fw-bold"><i class="bi bi-trophy text-accent me-2"></i>Уровень и XP</h6>
                <div class="mt-3">
                    <div class="d-flex align-items-center justify-content-between mb-3">
                        <div>
                            <div class="text-white fw-bold fs-3">${levelValue}</div>
                            <div class="text-muted small">Уровень</div>
                        </div>
                        <div class="text-end">
                            <div class="text-white fw-bold fs-3">${xpValue}</div>
                            <div class="text-muted small">Всего XP</div>
                        </div>
                    </div>

                    <div class="mb-3">
                        <div class="d-flex align-items-center justify-content-between mb-2">
                            <span class="text-white small fw-semibold">Прогресс до уровня ${levelValue + 1}</span>
                            <span class="text-accent small fw-bold">${progressPercentage}%</span>
                        </div>
                        <div class="progress" style="height: 12px; background: #2b2d31; border-radius: 6px;">
                            <div class="progress-bar" style="width: ${progressPercentage}%; background: var(--accent-color); border-radius: 6px; transition: width 0.3s ease;"></div>
                        </div>
                        <div class="d-flex align-items-center justify-content-between mt-2">
                            <span class="text-muted small">${xpInCurrent} / ${xpNeeded} XP</span>
                            <span class="text-muted small">${xpToNext} XP до следующего уровня</span>
                        </div>
                    </div>

                    <div class="row g-2 mt-3">
                        <div class="col-6">
                            <div class="text-muted small">Всего сообщений</div>
                            <div class="text-white fw-semibold">${totalMessages}</div>
                        </div>
                        <div class="col-6">
                            <div class="text-muted small">Левел-апов</div>
                            <div class="text-white fw-semibold">${levelUpCount}</div>
                        </div>
                    </div>

                    ${level.lastXpAt ? `
                        <div class="text-muted small mt-3">
                            <i class="bi bi-clock me-1"></i>Последнее начисление XP: ${formatDate(level.lastXpAt)}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    function renderLogText(text) {
        let html = escapeHtml(text);
        html = html.replace(/&lt;@&amp;(\d+)&gt;/g, () => '<span class="mp-mention">@роль</span>');
        html = html.replace(/&lt;@!?(\d+)&gt;/g, (m, id) => `<span class="mp-mention">@${escapeHtml(userOf(id).username)}</span>`);
        html = html.replace(/&lt;#(\d+)&gt;/g, () => '<span class="mp-mention">#канал</span>');
        return html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    }

    function renderLogs(d) {
        const body = d.logs.length ? d.logs.map((l) => {
            const meta = LOG_META[l.eventType] || LOG_META.other;
            return `
                <div class="mp-row mb-2">
                    <div class="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-1">
                        <span class="small fw-semibold">${meta.icon} ${meta.label}</span>
                        <span class="text-muted small">${formatDate(l.createdAt)}</span>
                    </div>
                    <div class="text-light small">${renderLogText(l.message)}</div>
                </div>`;
        }).join('') : '<div class="text-muted small">В журнале нет событий с этим участником.</div>';

        return `
            <div class="mp-card mb-3">
                <h6 class="text-white fw-bold"><i class="bi bi-journal-text text-accent me-2"></i>События в журнале
                    <span class="text-muted fw-normal small">(последние 15)</span></h6>
                ${body}
            </div>
        `;
    }

    function renderErrors(d) {
        const names = Object.keys(d.errors || {});
        if (!names.length) return '';
        return `
            <div class="alert alert-warning small mb-3">
                Часть данных не удалось загрузить: <strong>${names.map(escapeHtml).join(', ')}</strong>.
                Подробности — в консоли бота.
            </div>
        `;
    }

    function render(d) {
        contentEl.innerHTML = `
            ${renderErrors(d)}
            ${renderHeader(d)}
            ${renderSummary(d)}
            <div class="row g-3">
                <div class="col-xl-6">
                    ${renderLevel(d)}
                    ${renderWarnings(d)}
                    ${renderApplications(d)}
                    ${renderMembership(d)}
                </div>
                <div class="col-xl-6">
                    ${renderNotes(d)}
                    ${renderActivity(d)}
                    ${renderLogs(d)}
                </div>
            </div>
        `;
    }

    // ==========================================
    // Загрузка и действия
    // ==========================================

    async function loadProfile(id, { keepScroll = false } = {}) {
        currentId = id;
        const scrollY = window.scrollY;
        if (!keepScroll) showOnly('loading');

        try {
            const res = await fetch(`/api/members/${encodeURIComponent(id)}/profile`);
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Не удалось загрузить досье');
            if (currentId !== id) return; // за это время выбрали другого участника

            data = json;
            render(json);
            showOnly('content');
            if (keepScroll) window.scrollTo(0, scrollY);
            history.replaceState(null, '', `/dashboard?tab=member&id=${encodeURIComponent(id)}`);
        } catch (err) {
            console.error('Ошибка загрузки досье:', err);
            showError(err.message);
        }
    }

    async function addNote(button) {
        const input = document.getElementById('mpNoteInput');
        const text = input.value.trim();
        if (!text || !currentId) return;

        button.disabled = true;
        try {
            const res = await fetch(`/api/members/${encodeURIComponent(currentId)}/notes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                alert('Не удалось сохранить заметку: ' + (json.error || 'неизвестная ошибка'));
                button.disabled = false;
                return;
            }
            await loadProfile(currentId, { keepScroll: true });
        } catch (err) {
            console.error(err);
            alert('Ошибка соединения с сервером');
            button.disabled = false;
        }
    }

    async function deleteNote(noteId) {
        if (!confirm('Удалить эту заметку?')) return;
        try {
            const res = await fetch(`/api/members/notes/${encodeURIComponent(noteId)}/delete`, { method: 'POST' });
            const json = await res.json();
            if (!res.ok || !json.success) {
                alert('Не удалось удалить заметку: ' + (json.error || 'неизвестная ошибка'));
                return;
            }
            await loadProfile(currentId, { keepScroll: true });
        } catch (err) {
            console.error(err);
            alert('Ошибка соединения с сервером');
        }
    }

    contentEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;

        if (action === 'add-note') addNote(btn);
        else if (action === 'delete-note') deleteNote(btn.dataset.noteId);
        else if (action === 'refresh' && currentId) loadProfile(currentId, { keepScroll: true });
        else if (action === 'copy-id' && currentId) {
            navigator.clipboard.writeText(currentId).then(() => {
                const icon = btn.querySelector('i');
                if (icon) {
                    icon.className = 'bi bi-check2';
                    setTimeout(() => { icon.className = 'bi bi-clipboard'; }, 1200);
                }
            }).catch(() => {});
        }
    });

    // Ctrl+Enter в поле заметки — добавить
    contentEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'mpNoteInput') {
            e.preventDefault();
            const btn = document.getElementById('mpNoteAddBtn');
            if (btn) addNote(btn);
        }
    });

    // Прямая ссылка: /dashboard?tab=member&id=123...
    const initialId = new URLSearchParams(window.location.search).get('id');
    if (initialId && /^\d{15,25}$/.test(initialId)) {
        loadProfile(initialId);
    } else {
        showOnly('empty');
    }
});