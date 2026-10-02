document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('ticketLogsPage');
    if (!page) return;

    const listEl = document.getElementById('ticketLogsList');
    const emptyEl = document.getElementById('ticketLogsEmpty');
    const searchInput = document.getElementById('logsSearchInput');
    const exportBtn = document.getElementById('logsExportBtn');

    const userCache = new Map();
    let currentLogs = [];

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

    function durationBetween(start, end) {
        if (!start || !end) return '—';
        const diffMs = new Date(end) - new Date(start);
        const minutes = Math.round(diffMs / 60000);
        if (minutes < 60) return `${minutes} мин.`;
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        return `${hours} ч. ${remMinutes} мин.`;
    }

    async function renderLogs(logs) {
        if (!logs.length) {
            listEl.innerHTML = '';
            emptyEl.style.display = 'block';
            return;
        }
        emptyEl.style.display = 'none';

        const rowsHtml = await Promise.all(logs.map(async (log) => {
            const [author, moderator] = await Promise.all([
                resolveUser(log.user_id),
                resolveUser(log.moderator_id)
            ]);

            return `
                <div class="log-row">
                    <div class="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
                        <div class="d-flex align-items-center gap-2">
                            <span class="badge bg-secondary bg-opacity-25 text-light px-2 py-1">Тикет #${log.ticket_number}</span>
                            <span class="text-muted small">${escapeHtml(log.channel_name ? '#' + log.channel_name : '')}</span>
                        </div>
                        <span class="text-muted small"><i class="bi bi-clock me-1"></i>Длительность: ${durationBetween(log.opened_at, log.closed_at)}</span>
                    </div>

                    <div class="row g-3">
                        <div class="col-md-5">
                            <div class="d-flex align-items-center gap-2">
                                <img src="${author.avatar}" class="rounded-circle log-avatar">
                                <div>
                                    <div class="text-muted small">Открыл тикет</div>
                                    <div class="text-white fw-semibold small">${escapeHtml(author.username)}</div>
                                </div>
                            </div>
                        </div>
                        <div class="col-md-5">
                            <div class="d-flex align-items-center gap-2">
                                <img src="${moderator.avatar}" class="rounded-circle log-avatar">
                                <div>
                                    <div class="text-muted small">Закрыл</div>
                                    <div class="text-white fw-semibold small">${escapeHtml(moderator.username)}</div>
                                </div>
                            </div>
                        </div>
                        <div class="col-md-2 text-md-end">
                            <div class="text-muted small">Закрыт</div>
                            <div class="text-white small">${formatDate(log.closed_at)}</div>
                        </div>
                    </div>

                    <div class="mt-2 pt-2 border-top border-secondary border-opacity-10">
                        <span class="text-muted small">Причина: </span>
                        <span class="text-light small">${escapeHtml(log.reason || 'Не указана')}</span>
                    </div>
                </div>
            `;
        }));

        listEl.innerHTML = rowsHtml.join('');
    }

    async function loadLogs(search = '') {
        try {
            const url = search ? `/api/tickets/logs?search=${encodeURIComponent(search)}` : '/api/tickets/logs';
            const res = await fetch(url);
            currentLogs = await res.json();
            renderLogs(currentLogs);
        } catch (err) {
            console.error('Ошибка загрузки логов тикетов:', err);
        }
    }

    let searchTimeout = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => loadLogs(searchInput.value.trim()), 300);
    });

    exportBtn.addEventListener('click', () => {
        if (!currentLogs.length) return;
        const headers = ['Тикет №', 'ID открывшего', 'ID закрывшего', 'Причина', 'Открыт', 'Закрыт'];
        const rows = currentLogs.map(l => [l.ticket_number, l.user_id, l.moderator_id, l.reason, l.opened_at, l.closed_at]);
        const csvLines = [headers.join(',')];
        rows.forEach(row => csvLines.push(row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
        const blob = new Blob(['\uFEFF' + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ticket_logs.csv';
        a.click();
        URL.revokeObjectURL(url);
    });

    loadLogs();
});