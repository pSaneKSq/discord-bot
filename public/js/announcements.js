document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('announcementsPage');
    if (!page) return;

    const guildId = page.getAttribute('data-guild-id');
    const el = (id) => document.getElementById(id);

    const statusBox = el('announceStatus');
    const channelSelect = el('channelId');
    const roleSelect = el('pingRole');
    const templateSelect = el('templateSelect');
    const scheduledBox = el('scheduledList');

    let statusTimer = null;
    let templates = [];
    let channelsMap = {};

    // ---------- Вспомогательные функции ----------

    function showStatus(type, text) {
        statusBox.className = 'alert py-2 small mb-3 alert-' + type;
        statusBox.textContent = text;
        statusBox.style.display = 'block';
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { statusBox.style.display = 'none'; }, 8000);
    }

    async function api(url, method = 'GET', body) {
        const options = { method, headers: {} };
        if (body !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        const res = await fetch(url, options);
        let data = {};
        try { data = await res.json(); } catch (e) { /* пустой или не-JSON ответ */ }
        if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
        return data;
    }

    async function run(button, action) {
        const originalHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Подождите...';
        try {
            await action();
        } catch (err) {
            showStatus('danger', err.message);
        } finally {
            button.disabled = false;
            button.innerHTML = originalHtml;
        }
    }

    function setValue(id, value) {
        const node = el(id);
        if (!node) return;
        node.value = value;
        // Событие нужно, чтобы живой предпросмотр (dashboard.js) обновился
        node.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function readImageData() {
        const file = el('imageFileUpload').files[0];
        if (!file) return Promise.resolve('');
        if (file.size > 7 * 1024 * 1024) return Promise.reject(new Error('Картинка больше 7 МБ'));
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Не удалось прочитать файл картинки'));
            reader.readAsDataURL(file);
        });
    }

    async function collectPayload() {
        return {
            channelId: channelSelect.value,
            title: el('embedTitle').value.trim(),
            description: el('embedDescription').value.trim(),
            color: el('embedColor').value,
            author: el('embedAuthor').value.trim(),
            imageUrl: el('imageUrl').value.trim(),
            imageData: await readImageData(),
            pingRole: roleSelect.value
        };
    }

    function formatWhen(iso) {
        return new Date(iso).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    // ---------- Загрузка каналов и ролей ----------

    async function loadChannels() {
        try {
            const channels = await api(`/api/guilds/${guildId}/channels`);
            channelsMap = {};
            channels.forEach(c => { channelsMap[c.id] = c.name; });
            channelSelect.innerHTML = '<option value="">-- Выберите канал --</option>' +
                channels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
        } catch (err) {
            channelSelect.innerHTML = '<option value="">Ошибка загрузки каналов</option>';
        }
    }

    async function loadRoles() {
        try {
            const roles = await api(`/api/guilds/${guildId}/roles`);
            roleSelect.innerHTML = '<option value="">Не упоминать</option><option value="everyone">@everyone</option>' +
                roles.map(r => `<option value="${r.id}">@${escapeHtml(r.name)}</option>`).join('');
        } catch (err) {
            console.error('Ошибка загрузки ролей:', err);
        }
    }

    // ---------- Шаблоны ----------

    async function loadTemplates() {
        try {
            templates = await api('/api/announcements/templates');
        } catch (err) {
            templates = [];
        }
        templateSelect.innerHTML = '<option value="">-- Выберите шаблон --</option>' +
            templates.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
    }

    function applyTemplate(template) {
        const p = template.payload || {};
        if (p.channelId && channelsMap[p.channelId]) channelSelect.value = p.channelId;
        roleSelect.value = p.pingRole || '';
        setValue('embedTitle', p.title || '');
        setValue('embedDescription', p.description || '');
        setValue('embedColor', /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : '#8b5cf6');
        setValue('embedAuthor', p.author || '');
        setValue('imageUrl', p.imageUrl || '');
    }

    templateSelect.addEventListener('change', () => {
        const template = templates.find(t => t.id === templateSelect.value);
        if (template) applyTemplate(template);
    });

    el('deleteTemplateBtn').addEventListener('click', () => {
        const id = templateSelect.value;
        if (!id) return showStatus('warning', 'Сначала выберите шаблон в списке');
        if (!confirm('Удалить выбранный шаблон?')) return;
        run(el('deleteTemplateBtn'), async () => {
            await api(`/api/announcements/templates/${encodeURIComponent(id)}/delete`, 'POST', {});
            await loadTemplates();
            showStatus('success', 'Шаблон удалён');
        });
    });

    el('saveTemplateBtn').addEventListener('click', () => {
        const name = prompt('Название шаблона:');
        if (!name || !name.trim()) return;
        run(el('saveTemplateBtn'), async () => {
            const payload = await collectPayload();
            delete payload.imageData; // файл с устройства в шаблоне не хранится
            await api('/api/announcements/templates', 'POST', { ...payload, name: name.trim() });
            await loadTemplates();
            showStatus('success', 'Шаблон сохранён (картинка с устройства в шаблон не входит — только ссылка)');
        });
    });

    // ---------- Отправка / редактирование / планирование ----------

    el('sendEmbedBtn').addEventListener('click', () => {
        run(el('sendEmbedBtn'), async () => {
            const payload = await collectPayload();
            const data = await api('/api/announcements/send', 'POST', payload);
            el('messageId').value = data.messageId;
            showStatus('success', 'Объявление отправлено! ID сообщения подставлен в поле для редактирования.');
        });
    });

    el('editEmbedBtn').addEventListener('click', () => {
        const messageId = el('messageId').value.trim();
        if (!messageId) return showStatus('warning', 'Укажите ID сообщения, которое нужно отредактировать');
        run(el('editEmbedBtn'), async () => {
            const payload = await collectPayload();
            await api('/api/announcements/edit', 'POST', { ...payload, messageId });
            showStatus('success', 'Сообщение отредактировано');
        });
    });

    el('scheduleEmbedBtn').addEventListener('click', () => {
        const value = el('scheduleTime').value;
        if (!value) return showStatus('warning', 'Выберите дату и время отправки');
        run(el('scheduleEmbedBtn'), async () => {
            const payload = await collectPayload();
            await api('/api/announcements/schedule', 'POST', {
                ...payload,
                sendAt: new Date(value).toISOString()
            });
            el('scheduleTime').value = '';
            await loadScheduled();
            showStatus('success', 'Объявление запланировано');
        });
    });

    // ---------- Список запланированных ----------

    async function loadScheduled() {
        try {
            const items = await api('/api/announcements/scheduled');
            renderScheduled(items);
        } catch (err) {
            scheduledBox.innerHTML = '<div class="text-danger small">Не удалось загрузить список</div>';
        }
    }

    function renderScheduled(items) {
        if (!items.length) {
            scheduledBox.innerHTML = '<div class="text-muted small">Нет запланированных объявлений</div>';
            return;
        }

        scheduledBox.innerHTML = items.map(item => {
            const channelName = channelsMap[item.channelId] ? '#' + channelsMap[item.channelId] : item.channelId;
            const failed = item.status === 'failed';
            const title = item.title || (item.hasImage ? '(только картинка)' : '(без заголовка)');
            return `
                <div class="p-2 rounded-3 d-flex align-items-center justify-content-between gap-2"
                     style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);">
                    <div class="overflow-hidden">
                        <div class="text-white small fw-semibold text-truncate">${escapeHtml(title)}</div>
                        <div class="text-muted small">
                            <i class="bi bi-clock me-1"></i>${formatWhen(item.sendAt)} · ${escapeHtml(channelName)}
                        </div>
                        ${failed ? `<div class="small" style="color:#f87171;">Ошибка: ${escapeHtml(item.error || 'не удалось отправить')}</div>` : ''}
                    </div>
                    <button class="btn btn-sm btn-outline-danger flex-shrink-0 cancel-scheduled-btn" data-id="${escapeHtml(item.id)}" title="Отменить">
                        <i class="bi bi-x-lg"></i>
                    </button>
                </div>
            `;
        }).join('');
    }

    scheduledBox.addEventListener('click', async (e) => {
        const btn = e.target.closest('.cancel-scheduled-btn');
        if (!btn) return;
        if (!confirm('Отменить эту запланированную отправку?')) return;
        try {
            btn.disabled = true;
            await api(`/api/announcements/scheduled/${encodeURIComponent(btn.getAttribute('data-id'))}/cancel`, 'POST', {});
            await loadScheduled();
        } catch (err) {
            showStatus('danger', err.message);
            btn.disabled = false;
        }
    });

    // ---------- Старт ----------

    // Нельзя выбрать время в прошлом
    const scheduleInput = el('scheduleTime');
    if (scheduleInput) {
        const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
        scheduleInput.min = localNow.toISOString().slice(0, 16);
    }

    (async () => {
        await Promise.all([loadChannels(), loadRoles()]);
        await Promise.all([loadTemplates(), loadScheduled()]);
    })();

    // Обновляем список запланированных, чтобы отправленные пропадали сами
    setInterval(loadScheduled, 30 * 1000);
});