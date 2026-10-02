document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('ownerSettingsContainer');
    if (!container) return;

    const siteNameInput = document.getElementById('siteNameInput');
    const accentColorInput = document.getElementById('accentColorInput');
    const accentColorSecondaryInput = document.getElementById('accentColorSecondaryInput');
    const saveStyleBtn = document.getElementById('saveStyleBtn');

    const newIdInput = document.getElementById('newDiscordIdInput');
    const addIdBtn = document.getElementById('addDiscordIdBtn');
    const listContainer = document.getElementById('allowedIdsList');

    const defaultGuildSelect = document.getElementById('defaultGuildSelect');
    const saveDefaultGuildBtn = document.getElementById('saveDefaultGuildBtn');

    function renderIdsList(ids) {
        if (!ids.length) {
            listContainer.innerHTML = '<span class="text-muted small">Список пуст — добавьте хотя бы свой Discord ID</span>';
            return;
        }
        listContainer.innerHTML = ids.map(entry => `
            <div class="d-flex align-items-center justify-content-between p-2 rounded-3" style="background: #121318; border: 1px solid rgba(255,255,255,0.08);">
                <div class="d-flex align-items-center gap-2">
                    <img src="${entry.avatar}" class="rounded-circle" width="28" height="28">
                    <div>
                        <div class="text-white small fw-semibold">${escapeHtml(entry.username)}</div>
                        <div class="text-muted font-monospace" style="font-size: 0.7rem;">${escapeHtml(entry.id)}</div>
                    </div>
                </div>
                <button type="button" class="btn btn-sm btn-outline-danger remove-id-btn" data-id="${entry.id}" title="Убрать доступ">
                    <i class="bi bi-trash-fill"></i>
                </button>
            </div>
        `).join('');

        listContainer.querySelectorAll('.remove-id-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const discordId = btn.getAttribute('data-id');
                if (!confirm(`Убрать доступ для ${discordId}?`)) return;
                try {
                    const res = await fetch('/api/settings/access/remove', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ discordId })
                    });
                    const data = await res.json();
                    if (data.success) {
                        loadSettings();
                    } else {
                        alert('Не удалось убрать доступ: ' + (data.error || 'неизвестная ошибка'));
                    }
                } catch (err) {
                    console.error(err);
                    alert('Ошибка соединения с сервером');
                }
            });
        });
    }

    async function loadSettings() {
        try {
            const res = await fetch('/api/settings');
            const data = await res.json();

            if (data.style) {
                siteNameInput.value = data.style.siteName || '';
                accentColorInput.value = data.style.accentColor || '#8b5cf6';
                accentColorSecondaryInput.value = data.style.accentColorSecondary || '#5865F2';
                defaultGuildSelect.value = data.style.defaultGuildId || '';
            }

            renderIdsList(data.allowedIds || []);

            // Загружаем список серверов
            if (defaultGuildSelect) {
                try {
                    const guildsRes = await fetch('/api/guilds');
                    const guildsData = await guildsRes.json();
                    if (guildsData.guilds) {
                        defaultGuildSelect.innerHTML = '<option value="">-- Не выбрано --</option>' +
                            guildsData.guilds.map(guild =>
                                `<option value="${guild.id}">${escapeHtml(guild.name)}</option>`
                            ).join('');
                    }
                } catch (err) {
                    console.error('Ошибка загрузки серверов:', err);
                }
            }

            if (!data.ownerConfigured) {
                listContainer.insertAdjacentHTML('afterbegin', `
                    <div class="alert alert-danger small mb-2" style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: #fecaca;">
                        <i class="bi bi-exclamation-triangle-fill me-1"></i>
                        В <code>.env</code> не задан <code>OWNER_DISCORD_ID</code> — без него вы сами можете потерять доступ через Discord-вход, если случайно удалите свой ID из списка ниже.
                    </div>
                `);
            }
        } catch (err) {
            console.error('Ошибка загрузки настроек:', err);
            listContainer.innerHTML = '<span class="text-danger small">Не удалось загрузить настройки</span>';
        }
    }

    if (saveStyleBtn) {
        saveStyleBtn.addEventListener('click', async () => {
            try {
                saveStyleBtn.disabled = true;
                const res = await fetch('/api/settings/style', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        siteName: siteNameInput.value.trim(),
                        accentColor: accentColorInput.value,
                        accentColorSecondary: accentColorSecondaryInput.value
                    })
                });
                const data = await res.json();
                if (data.success) {
                    alert('Стиль сохранён! Обновите страницу, чтобы увидеть изменения везде.');
                    location.reload();
                } else {
                    alert('Ошибка: ' + (data.error || 'неизвестная ошибка'));
                }
            } catch (err) {
                console.error(err);
                alert('Ошибка соединения с сервером');
            } finally {
                saveStyleBtn.disabled = false;
            }
        });
    }

    if (addIdBtn) {
        addIdBtn.addEventListener('click', async () => {
            const discordId = newIdInput.value.trim();
            if (!discordId) return;

            try {
                addIdBtn.disabled = true;
                const res = await fetch('/api/settings/access/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ discordId })
                });
                const data = await res.json();
                if (data.success) {
                    newIdInput.value = '';
                    loadSettings();
                } else {
                    alert('Ошибка: ' + (data.error || 'неизвестная ошибка'));
                }
            } catch (err) {
                console.error(err);
                alert('Ошибка соединения с сервером');
            } finally {
                addIdBtn.disabled = false;
            }
        });
    }

    if (saveDefaultGuildBtn) {
        saveDefaultGuildBtn.addEventListener('click', async () => {
            try {
                saveDefaultGuildBtn.disabled = true;
                const res = await fetch('/api/settings/default-guild', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ guildId: defaultGuildSelect.value })
                });
                const data = await res.json();
                if (data.success) {
                    alert('Сервер по умолчанию сохранён!');
                } else {
                    alert('Ошибка: ' + (data.error || 'неизвестная ошибка'));
                }
            } catch (err) {
                console.error(err);
                alert('Ошибка соединения с сервером');
            } finally {
                saveDefaultGuildBtn.disabled = false;
            }
        });
    }

    loadSettings();
});