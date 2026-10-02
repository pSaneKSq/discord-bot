document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('moderationWarningsPage');
    if (!page) return;

    const listEl = document.getElementById('moderationWarningsList');
    const emptyEl = document.getElementById('moderationWarningsEmpty');
    const searchInput = document.getElementById('warnsSearchInput');
    const statusFilter = document.getElementById('warnsStatusFilter');

    const userCache = new Map();
    let allWarnings = [];

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
        const d = new Date(dateStr);
        return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    // Состояние варна: бессрочный, действующий или истёкший
    function warnState(w) {
        if (!w.expires_at) {
            return {
                key: 'permanent',
                html: '<span class="badge" style="background: rgba(139,92,246,0.15); color: #a78bfa; border: 1px solid rgba(139,92,246,0.3);">♾️ Бессрочно</span>'
            };
        }
        const expires = new Date(w.expires_at);
        if (expires > new Date()) {
            return {
                key: 'active',
                html: `<span class="badge" style="background: rgba(234,179,8,0.15); color: #fbbf24; border: 1px solid rgba(234,179,8,0.3);">⏳ Активно до ${expires.toLocaleDateString('ru-RU')}</span>`
            };
        }
        return {
            key: 'expired',
            html: '<span class="badge" style="background: rgba(107,114,128,0.2); color: #9ca3af; border: 1px solid rgba(107,114,128,0.3);">✔️ Истекло</span>'
        };
    }

    async function renderWarnings() {
        const filter = statusFilter.value;
        const warnings = allWarnings.filter(w => {
            const state = warnState(w).key;
            if (filter === 'active') return state !== 'expired';
            if (filter === 'expired') return state === 'expired';
            return true;
        });

        if (!warnings.length) {
            listEl.innerHTML = '';
            emptyEl.style.display = 'block';
            return;
        }
        emptyEl.style.display = 'none';

        const rowsHtml = await Promise.all(warnings.map(async (w) => {
            const [target, moderator] = await Promise.all([
                resolveUser(w.user_id),
                resolveUser(w.moderator_id)
            ]);
            const state = warnState(w);

            return `
                <div class="warn-row d-flex align-items-center justify-content-between flex-wrap gap-3" data-warn-id="${w.id}">
                    <div class="d-flex align-items-center gap-2">
                        <img src="${target.avatar}" class="rounded-circle warn-avatar">
                        <div>
                            <div class="text-white fw-semibold small">${escapeHtml(target.username)}</div>
                            <div class="text-muted small">Причина: ${escapeHtml(w.reason || 'Не указана')}</div>
                        </div>
                    </div>
                    <div class="d-flex align-items-center gap-2">
                        <img src="${moderator.avatar}" class="rounded-circle warn-avatar">
                        <div>
                            <div class="text-muted small">Выдал</div>
                            <div class="text-white small">${escapeHtml(moderator.username)}</div>
                        </div>
                    </div>
                    <div>${state.html}</div>
                    <div class="text-muted small">${formatDate(w.created_at)}</div>
                    <button class="btn btn-sm btn-outline-danger warn-delete-btn" data-warn-id="${w.id}"><i class="bi bi-trash"></i></button>
                </div>
            `;
        }));

        listEl.innerHTML = rowsHtml.join('');

        listEl.querySelectorAll('.warn-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-warn-id');
                if (!confirm('Снять это предупреждение?')) return;
                try {
                    await fetch(`/api/moderation/warnings/${id}/delete`, { method: 'POST' });
                    loadWarnings();
                } catch (err) {
                    console.error('Ошибка снятия предупреждения:', err);
                }
            });
        });
    }

    async function loadWarnings() {
        try {
            const params = new URLSearchParams();
            if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
            const res = await fetch(`/api/moderation/warnings?${params.toString()}`);
            allWarnings = await res.json();
            renderWarnings();
        } catch (err) {
            console.error('Ошибка загрузки предупреждений:', err);
        }
    }

    let searchTimeout = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(loadWarnings, 300);
    });
    statusFilter.addEventListener('change', renderWarnings);

    loadWarnings();
});