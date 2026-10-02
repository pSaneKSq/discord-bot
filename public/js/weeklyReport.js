document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('weeklyReportPage');
    if (!page) return;

    const guildId = page.getAttribute('data-guild-id');
    const el = (id) => document.getElementById(id);

    const enabled = el('wrEnabled');
    const channel = el('wrChannel');
    const day = el('wrDay');
    const time = el('wrTime');
    const timezone = el('wrTimezone');
    const pingRole = el('wrPingRole');
    const color = el('wrColor');
    const content = el('wrContent');
    const title = el('wrTitle');
    const description = el('wrDescription');
    const footer = el('wrFooter');
    const imageUrl = el('wrImageUrl');
    const thumbnail = el('wrThumbnail');
    const timestamp = el('wrTimestamp');
    const topLimit = el('wrTopLimit');
    const sectionBoxes = Array.from(document.querySelectorAll('.wr-section'));

    const alertBox = el('wrAlert');
    const statusBox = el('wrStatus');
    const previewBox = el('wrPreview');
    const saveBtn = el('wrSaveBtn');
    const sendBtn = el('wrSendNowBtn');
    const refreshBtn = el('wrRefreshPreviewBtn');

    let alertTimer = null;
    let previewTimer = null;
    let previewSeq = 0;

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

    function formatWhen(ms) {
        return new Date(ms).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    // ---------- Форма ↔ настройки ----------

    function collect() {
        const sections = {};
        sectionBoxes.forEach(cb => { sections[cb.getAttribute('data-section')] = cb.checked; });
        return {
            enabled: enabled.checked,
            channelId: channel.value,
            dayOfWeek: parseInt(day.value, 10),
            time: time.value,
            timezone: timezone.value,
            pingRole: pingRole.value,
            content: content.value,
            topLimit: parseInt(topLimit.value, 10) || 5,
            embed: {
                color: color.value,
                title: title.value,
                description: description.value,
                footer: footer.value,
                imageUrl: imageUrl.value.trim(),
                thumbnail: thumbnail.checked,
                timestamp: timestamp.checked
            },
            sections
        };
    }

    function apply(s) {
        enabled.checked = !!s.enabled;
        if (s.channelId) channel.value = s.channelId;
        day.value = String(s.dayOfWeek);
        time.value = s.time;

        if (![...timezone.options].some(o => o.value === s.timezone)) {
            timezone.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(s.timezone)}">${escapeHtml(s.timezone)}</option>`);
        }
        timezone.value = s.timezone;

        pingRole.value = s.pingRole || '';
        content.value = s.content || '';
        topLimit.value = s.topLimit;

        color.value = s.embed.color;
        title.value = s.embed.title;
        description.value = s.embed.description;
        footer.value = s.embed.footer;
        imageUrl.value = s.embed.imageUrl;
        thumbnail.checked = !!s.embed.thumbnail;
        timestamp.checked = !!s.embed.timestamp;

        sectionBoxes.forEach(cb => { cb.checked = !!s.sections[cb.getAttribute('data-section')]; });
    }

    function renderStatus(status, isEnabled) {
        const lines = [];
        if (isEnabled && status.nextRunText) {
            lines.push(`<i class="bi bi-alarm me-1"></i>Следующая отправка: <span class="text-white">${escapeHtml(status.nextRunText)}</span>`);
        } else if (!isEnabled) {
            lines.push('<i class="bi bi-pause-circle me-1"></i>Отчёт выключен — по расписанию не отправляется.');
        }
        if (status.lastSentAt) {
            lines.push(`<i class="bi bi-check-circle me-1"></i>Последний отчёт по расписанию: ${escapeHtml(formatWhen(status.lastSentAt))}`);
        }
        if (status.lastSkippedAt) {
            lines.push(`<i class="bi bi-skip-forward-circle me-1"></i>Последний пропуск: ${escapeHtml(status.lastSkipText || formatWhen(status.lastSkippedAt))}`);
        }
        if (status.lastError) {
            lines.push(`<span style="color:#f87171;"><i class="bi bi-exclamation-triangle me-1"></i>Последняя ошибка отправки: ${escapeHtml(status.lastError)}</span>`);
        }
        statusBox.innerHTML = lines.join('<br>');
    }

    // ---------- Загрузка каналов и ролей ----------

    async function loadChannels() {
        try {
            const channels = await api(`/api/guilds/${guildId}/channels`);
            channel.innerHTML = '<option value="">-- Выберите канал --</option>' +
                channels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
        } catch (err) {
            channel.innerHTML = '<option value="">Ошибка загрузки каналов</option>';
        }
    }

    async function loadRoles() {
        try {
            const roles = await api(`/api/guilds/${guildId}/roles`);
            pingRole.innerHTML = '<option value="">Не упоминать</option><option value="everyone">@everyone</option>' +
                roles.map(r => `<option value="${r.id}">@${escapeHtml(r.name)}</option>`).join('');
        } catch (err) {
            console.error('Ошибка загрузки ролей:', err);
        }
    }

    // ---------- Предпросмотр ----------

    // Текст → безопасный HTML: **жирный** и переносы строк
    function rich(text) {
        return escapeHtml(text || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    }

    function renderPreview(data) {
        const e = data.embed || {};
        const borderColor = e.color !== undefined ? '#' + Number(e.color).toString(16).padStart(6, '0') : '#8b5cf6';

        const fieldsHtml = (e.fields || []).map(f => `
            <div class="wr-embed-field">
                <div class="wr-embed-field-name">${escapeHtml(f.name)}</div>
                <div class="wr-embed-field-value">${rich(f.value)}</div>
            </div>
        `).join('');

        const thumb = e.thumbnail && e.thumbnail.url ? `<img class="wr-embed-thumb" src="${escapeHtml(e.thumbnail.url)}" alt="">` : '';
        const image = e.image && e.image.url ? `<img class="wr-embed-image" src="${escapeHtml(e.image.url)}" alt="">` : '';
        const foot = e.footer && e.footer.text ? escapeHtml(e.footer.text) : '';
        const ts = e.timestamp ? formatWhen(e.timestamp) : '';
        const footerLine = [foot, ts].filter(Boolean).join(' • ');

        previewBox.innerHTML = `
            ${data.content ? `<div class="wr-discord-content">${rich(data.content)}</div>` : ''}
            <div class="wr-embed" style="border-left-color:${borderColor};">
                ${thumb}
                ${e.title ? `<div class="wr-embed-title">${escapeHtml(e.title)}</div>` : ''}
                ${e.description ? `<div class="wr-embed-desc">${rich(e.description)}</div>` : ''}
                ${fieldsHtml ? `<div class="wr-embed-fields">${fieldsHtml}</div>` : ''}
                ${image}
                ${footerLine ? `<div class="wr-embed-footer">${footerLine}</div>` : ''}
            </div>
        `;
    }

    async function loadPreview() {
        const seq = ++previewSeq;
        try {
            const data = await api('/api/weekly-report/preview', 'POST', collect());
            if (seq !== previewSeq) return; // пришёл устаревший ответ
            renderPreview(data);
        } catch (err) {
            if (seq !== previewSeq) return;
            previewBox.innerHTML = `<span class="small" style="color:#f87171;">Не удалось построить предпросмотр: ${escapeHtml(err.message)}</span>`;
        }
    }

    function schedulePreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(loadPreview, 700);
    }

    // ---------- Кнопки ----------

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

    saveBtn.addEventListener('click', () => run(saveBtn, async () => {
        const data = await api('/api/weekly-report/settings', 'POST', collect());
        apply(data.settings);
        renderStatus(data.status, data.settings.enabled);
        showAlert('success', 'Настройки сохранены');
        loadPreview();
    }));

    sendBtn.addEventListener('click', () => {
        if (!channel.value) return showAlert('warning', 'Сначала выберите канал для отчёта');
        if (!confirm('Отправить отчёт в выбранный канал прямо сейчас?')) return;
        run(sendBtn, async () => {
            await api('/api/weekly-report/send', 'POST', collect());
            showAlert('success', 'Отчёт отправлен в Discord');
        });
    });

    refreshBtn.addEventListener('click', loadPreview);

    // Любое изменение полей → предпросмотр обновляется (с задержкой, чтобы не дёргать базу на каждую букву)
    page.querySelectorAll('input, select, textarea').forEach(node => {
        if (node === enabled) return;
        node.addEventListener('input', schedulePreview);
        node.addEventListener('change', schedulePreview);
    });

    // ---------- Старт ----------

    (async () => {
        await Promise.all([loadChannels(), loadRoles()]);
        try {
            const data = await api('/api/weekly-report/settings');
            apply(data.settings);
            renderStatus(data.status, data.settings.enabled);
        } catch (err) {
            showAlert('danger', 'Не удалось загрузить настройки: ' + err.message);
        }
        loadPreview();
    })();

    // Статус (следующая отправка, последний пропуск) обновляем раз в минуту
    setInterval(async () => {
        try {
            const data = await api('/api/weekly-report/settings');
            renderStatus(data.status, data.settings.enabled);
        } catch (err) { /* не критично */ }
    }, 60 * 1000);
});