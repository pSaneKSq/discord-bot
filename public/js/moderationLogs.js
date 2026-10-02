document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('moderationLogsPage');
    if (!page) return;

    const guildId = page.getAttribute('data-guild-id');
    const listEl = document.getElementById('moderationLogsList');
    const emptyEl = document.getElementById('moderationLogsEmpty');
    const searchInput = document.getElementById('logsSearchInput');
    const typeSelect = document.getElementById('logTypeFilterSelect');
    const exportBtn = document.getElementById('logsExportBtn');

    let currentLogs = [];

    const EVENT_META = {
        warn: { icon: '⚠️', label: 'Предупреждение', bg: 'rgba(234,179,8,0.15)', color: '#fbbf24' },
        member_join: { icon: '📥', label: 'Вход участника', bg: 'rgba(34,197,94,0.15)', color: '#4ade80' },
        member_leave: { icon: '📤', label: 'Выход участника', bg: 'rgba(107,114,128,0.2)', color: '#9ca3af' },
        sostav_call: { icon: '🚨', label: 'Созыв состава', bg: 'rgba(239,68,68,0.15)', color: '#f87171' },
        form_decision: { icon: '📝', label: 'Решение по заявке', bg: 'rgba(59,130,246,0.15)', color: '#60a5fa' },
        automod: { icon: '🤖', label: 'Автомодерация', bg: 'rgba(249,115,22,0.15)', color: '#fb923c' },
        message_edit: { icon: '✏️', label: 'Правка сообщения', bg: 'rgba(56,189,248,0.15)', color: '#38bdf8' },
        message_delete: { icon: '🗑️', label: 'Удаление сообщения', bg: 'rgba(239,68,68,0.15)', color: '#f87171' },
        weekly_report: { icon: '📊', label: 'Еженедельный отчёт', bg: 'rgba(139,92,246,0.15)', color: '#a78bfa' },
        poll: { icon: '🗳️', label: 'Опросы', bg: 'rgba(6,182,212,0.15)', color: '#22d3ee' },
        other: { icon: 'ℹ️', label: 'Событие', bg: 'rgba(139,92,246,0.15)', color: '#a78bfa' }
    };

    // ---------- Имена для упоминаний ----------

    const userCache = new Map();
    const channelNames = {};
    const roleNames = {};
    let directoriesLoaded = false;

    async function loadDirectories() {
        if (directoriesLoaded) return;
        directoriesLoaded = true;
        try {
            const [chRes, roleRes] = await Promise.all([
                fetch(`/api/guilds/${guildId}/channels`),
                fetch(`/api/guilds/${guildId}/roles`)
            ]);
            const channels = await chRes.json();
            const roles = await roleRes.json();
            if (Array.isArray(channels)) channels.forEach(c => { channelNames[c.id] = c.name; });
            if (Array.isArray(roles)) roles.forEach(r => { roleNames[r.id] = r.name; });
        } catch (err) {
            console.warn('Не удалось загрузить каналы/роли для журнала:', err);
        }
    }

    async function resolveUser(userId) {
        if (userCache.has(userId)) return userCache.get(userId);
        try {
            const res = await fetch(`/api/discord/users/${userId}`);
            const data = await res.json();
            userCache.set(userId, data.username || userId);
        } catch (err) {
            userCache.set(userId, userId);
        }
        return userCache.get(userId);
    }

    async function preloadUsers(logs) {
        const ids = new Set();
        logs.forEach(log => {
            for (const match of String(log.message || '').matchAll(/<@!?(\d+)>/g)) ids.add(match[1]);
        });
        await Promise.all([...ids].map(resolveUser));
    }

    // ---------- Отрисовка ----------

    function mention(prefix, name) {
        return `<span class="log-mention">${prefix}${escapeHtml(name)}</span>`;
    }

    // Текст лога → безопасный HTML: упоминания именами, ссылки на сообщения, **жирный**, переносы строк
    function renderRich(text) {
        let html = escapeHtml(text);

        // После escapeHtml символы < > & превращены в &lt; &gt; &amp;
        html = html.replace(/&lt;@&amp;(\d+)&gt;/g, (m, id) => mention('@', roleNames[id] || 'роль'));
        html = html.replace(/&lt;@!?(\d+)&gt;/g, (m, id) => mention('@', userCache.get(id) || id));
        html = html.replace(/&lt;#(\d+)&gt;/g, (m, id) => mention('#', channelNames[id] || 'канал'));

        // Кликабельными делаем только ссылки на сообщения Discord (в них только цифры — это безопасно)
        html = html.replace(
            /https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/g,
            (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">перейти к сообщению</a>`
        );

        return html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    }

    function formatDate(dateStr) {
        const d = new Date(dateStr);
        return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function renderLogs(logs) {
        if (!logs.length) {
            listEl.innerHTML = '';
            emptyEl.style.display = 'block';
            return;
        }
        emptyEl.style.display = 'none';

        listEl.innerHTML = logs.map(log => {
            const meta = EVENT_META[log.event_type] || EVENT_META.other;
            return `
                <div class="log-row">
                    <div class="log-icon" style="background:${meta.bg}; color:${meta.color};">${meta.icon}</div>
                    <div class="flex-grow-1">
                        <div class="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-1">
                            <span class="fw-semibold small" style="color:${meta.color};">${meta.label}</span>
                            <span class="text-muted small">${formatDate(log.created_at)}</span>
                        </div>
                        <div class="text-light small">${renderRich(log.message)}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    async function loadLogs() {
        try {
            const params = new URLSearchParams();
            if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
            if (typeSelect.value) params.set('eventType', typeSelect.value);

            const res = await fetch(`/api/moderation/logs?${params.toString()}`);
            currentLogs = await res.json();

            await Promise.all([loadDirectories(), preloadUsers(currentLogs)]);
            renderLogs(currentLogs);
        } catch (err) {
            console.error('Ошибка загрузки журнала:', err);
        }
    }

    let searchTimeout = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(loadLogs, 300);
    });
    typeSelect.addEventListener('change', loadLogs);

    exportBtn.addEventListener('click', () => {
        if (!currentLogs.length) return;
        const headers = ['Тип события', 'Сообщение', 'Дата'];
        const rows = currentLogs.map(l => [l.event_type, l.message, l.created_at]);
        const csvLines = [headers.join(',')];
        rows.forEach(row => csvLines.push(row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
        const blob = new Blob(['\uFEFF' + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'moderation_logs.csv';
        a.click();
        URL.revokeObjectURL(url);
    });

    loadLogs();
});