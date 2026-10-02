document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('reactionRolesPage');
    if (!page) return;

    const guildId = page.getAttribute('data-guild-id');
    const el = (id) => document.getElementById(id);

    let currentReactionRole = null;
    let reactionRolesList = [];
    let uploadedImage = null; // хранит загруженное изображение
    let allRoles = []; // хранит все роли сервера для отображения названий

    // Элементы формы
    const titleInput = el('rr-title');
    const descInput = el('rr-description');
    const colorInput = el('rr-color');
    const imageInput = el('rr-image');
    const emojiInput = el('rr-emoji');
    const roleSelect = el('rr-role');
    const labelInput = el('rr-label');
    const channelSelect = el('rr-channel');

    // Элементы предпросмотра
    const previewTitle = el('rr-preview-title');
    const previewDesc = el('rr-preview-desc');
    const previewImage = el('rr-preview-image');
    const previewFields = el('rr-preview-fields');
    const previewEmbed = el('rr-preview');
    const removeImageBtn = el('rr-remove-image');

    // Списки
    const listContainer = el('rr-list-container');
    const mappingsList = el('rr-mappings-list');

    // Табы
    const tabs = document.querySelectorAll('.rr-tab');
    const panes = document.querySelectorAll('.rr-pane');

    // Переключение табов
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.getAttribute('data-tab');
            
            tabs.forEach(t => t.classList.remove('active'));
            panes.forEach(p => p.classList.remove('active'));
            
            tab.classList.add('active');
            el(`rr-pane-${tabName}`).classList.add('active');

            if (tabName === 'list') {
                loadReactionRoles();
            } else if (tabName === 'create') {
                resetForm();
            }
        });
    });

    // Обновление предпросмотра
    function updatePreview() {
        previewTitle.textContent = titleInput.value || 'Заголовок автороли';
        previewDesc.textContent = descInput.value || 'Описание автороли';
        previewEmbed.style.borderLeftColor = colorInput.value;

        // Обновляем изображение
        if (uploadedImage) {
            previewImage.src = uploadedImage;
            previewImage.style.display = 'block';
        } else if (currentReactionRole && currentReactionRole.image) {
            previewImage.src = currentReactionRole.image;
            previewImage.style.display = 'block';
        } else {
            previewImage.style.display = 'none';
        }

        // Обновляем поля
        if (currentReactionRole && currentReactionRole.mappings) {
            previewFields.innerHTML = currentReactionRole.mappings
                .map(m => `
                    <div class="rr-embed-field">
                        <div class="rr-embed-field-name">${m.emoji} — ${m.label || 'Роль'}</div>
                    </div>
                `).join('');
        } else {
            previewFields.innerHTML = '';
        }
    }

    titleInput.addEventListener('input', updatePreview);
    descInput.addEventListener('input', updatePreview);
    colorInput.addEventListener('input', updatePreview);

    // Обработка загрузки изображения
    imageInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                uploadedImage = event.target.result;
                removeImageBtn.style.display = 'inline-block';
                updatePreview();
            };
            reader.readAsDataURL(file);
        }
    });

    // Удаление изображения
    removeImageBtn.addEventListener('click', () => {
        uploadedImage = null;
        imageInput.value = '';
        removeImageBtn.style.display = 'none';
        updatePreview();
    });

    // Загрузка каналов
    async function loadChannels() {
        try {
            const res = await fetch(`/api/guilds/${guildId}/channels`);
            const channels = await res.json();
            
            // В Discord.js текстовые каналы имеют тип 0, но API может возвращать разные типы
            // Попробуем показывать все каналы, кроме голосовых (тип 2)
            const textChannels = channels.filter(c => c.type !== 2); // Исключаем голосовые каналы
            
            channelSelect.innerHTML = '<option value="">Выберите канал</option>' +
                textChannels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
        } catch (err) {
            console.error('Ошибка загрузки каналов:', err);
            channelSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        }
    }

    // Загрузка ролей
    async function loadRoles() {
        try {
            const res = await fetch(`/api/guilds/${guildId}/roles`);
            const roles = await res.json();
            
            // Фильтруем роль @everyone и сортируем по позиции
            const filteredRoles = roles
                .filter(r => r.name !== '@everyone')
                .sort((a, b) => b.position - a.position);
            
            allRoles = filteredRoles; // Сохраняем для отображения в маппингах
            
            roleSelect.innerHTML = '<option value="">Выберите роль</option>' +
                filteredRoles.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
        } catch (err) {
            console.error('Ошибка загрузки ролей:', err);
            roleSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        }
    }

    // Загрузка списка авторолей
    async function loadReactionRoles() {
        try {
            const res = await fetch('/api/reaction-roles');
            reactionRolesList = await res.json();
            renderReactionRolesList();
        } catch (err) {
            console.error('Ошибка загрузки авторолей:', err);
            listContainer.innerHTML = '<div class="text-center text-danger py-4">Ошибка загрузки авторолей</div>';
        }
    }

    // Рендер списка авторолей
    function renderReactionRolesList() {
        if (reactionRolesList.length === 0) {
            listContainer.innerHTML = '<div class="text-center text-muted py-4">Нет созданных авторолей</div>';
            return;
        }

        listContainer.innerHTML = reactionRolesList.map(rr => `
            <div class="rr-list-item">
                <div class="rr-list-color" style="background: ${rr.color}"></div>
                <div class="rr-list-info">
                    <div class="rr-list-title">${escapeHtml(rr.title)}</div>
                    <div class="rr-list-desc">${escapeHtml(rr.description || 'Без описания')}</div>
                    <div class="rr-list-meta">
                        ${rr.mappings ? rr.mappings.length : 0} маппингов
                        ${rr.channel_id ? `• Канал: <#${rr.channel_id}>` : '• Не опубликовано'}
                    </div>
                </div>
                <div class="rr-list-actions">
                    <button class="rr-btn rr-btn-primary" onclick="editReactionRole(${rr.id})">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="rr-btn rr-btn-danger" onclick="deleteReactionRole(${rr.id})">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    // Сброс формы
    function resetForm() {
        currentReactionRole = null;
        uploadedImage = null;
        titleInput.value = '';
        descInput.value = '';
        colorInput.value = '#5865F2';
        imageInput.value = '';
        emojiInput.value = '';
        roleSelect.value = '';
        labelInput.value = '';
        channelSelect.value = '';
        removeImageBtn.style.display = 'none';
        
        renderMappings();
        updatePreview();
    }

    // Рендер маппингов
    function renderMappings() {
        if (!currentReactionRole || !currentReactionRole.mappings || currentReactionRole.mappings.length === 0) {
            mappingsList.innerHTML = '<div class="text-center text-muted py-3">Нет добавленных маппингов</div>';
            return;
        }

        mappingsList.innerHTML = currentReactionRole.mappings.map(m => {
            const role = allRoles.find(r => r.id === m.role_id);
            const roleName = role ? escapeHtml(role.name) : m.role_id;
            
            return `
            <div class="rr-mapping-item">
                <div class="rr-mapping-emoji">${m.emoji}</div>
                <div class="rr-mapping-info">
                    <div class="rr-mapping-label">${escapeHtml(m.label || 'Роль')}</div>
                    <div class="rr-mapping-role">🎭 ${roleName}</div>
                </div>
                <div class="rr-mapping-actions">
                    <button class="rr-mapping-edit" onclick="editMapping(${m.id})">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="rr-mapping-delete" onclick="deleteMapping(${m.id})">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>
        `;
        }).join('');
    }

    // Сохранение основных настроек
    el('rr-save-basic').addEventListener('click', async () => {
        try {
            const title = titleInput.value.trim();
            if (!title) {
                alert('Укажите заголовок автороли');
                return;
            }

            const payload = {
                title: title,
                description: descInput.value.trim(),
                color: colorInput.value,
                image: uploadedImage || (currentReactionRole ? currentReactionRole.image : null)
            };

            let res;
            if (currentReactionRole) {
                res = await fetch(`/api/reaction-roles/${currentReactionRole.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } else {
                res = await fetch('/api/reaction-roles', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            }

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка сохранения');

            currentReactionRole = data.reactionRole;
            alert('Сохранено!');
            updatePreview();
        } catch (err) {
            console.error('Ошибка сохранения:', err);
            alert('Ошибка сохранения: ' + err.message);
        }
    });

    let editingMappingId = null; // ID редактируемого маппинга

    // Добавление/обновление маппинга
    el('rr-add-mapping').addEventListener('click', async () => {
        if (!currentReactionRole) {
            alert('Сначала сохраните автороль');
            return;
        }

        const emoji = emojiInput.value.trim();
        const roleId = roleSelect.value;
        const label = labelInput.value.trim();

        if (!emoji || !roleId) {
            alert('Укажите эмодзи и роль');
            return;
        }

        try {
            let res;
            if (editingMappingId) {
                // Обновление существующего маппинга
                res = await fetch(`/api/reaction-roles/${currentReactionRole.id}/mappings/${editingMappingId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ emoji, roleId, label })
                });
            } else {
                // Добавление нового маппинга
                res = await fetch(`/api/reaction-roles/${currentReactionRole.id}/mappings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ emoji, roleId, label })
                });
            }

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка сохранения маппинга');

            // Обновляем текущую автороль
            currentReactionRole = await (await fetch(`/api/reaction-roles`)).json()
                .then(list => list.find(r => r.id === currentReactionRole.id));

            // Сбрасываем форму
            emojiInput.value = '';
            roleSelect.value = '';
            labelInput.value = '';
            editingMappingId = null;
            el('rr-add-mapping').innerHTML = '<i class="bi bi-plus-lg"></i>';

            renderMappings();
            updatePreview();
        } catch (err) {
            console.error('Ошибка сохранения маппинга:', err);
            alert('Ошибка сохранения маппинга: ' + err.message);
        }
    });

    // Публикация в Discord
    el('rr-publish').addEventListener('click', async () => {
        if (!currentReactionRole) {
            alert('Сначала сохраните автороль');
            return;
        }

        const channelId = channelSelect.value;
        if (!channelId) {
            alert('Выберите канал для отправки');
            return;
        }

        try {
            const res = await fetch(`/api/reaction-roles/${currentReactionRole.id}/publish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channelId })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка публикации');

            const statusEl = el('rr-publish-status');
            statusEl.textContent = `✅ Отправлено! Сообщение: <#${data.channelId}>`;
            statusEl.style.display = 'block';
            setTimeout(() => statusEl.style.display = 'none', 5000);

            // Обновляем список
            loadReactionRoles();
        } catch (err) {
            console.error('Ошибка публикации:', err);
            alert('Ошибка публикации: ' + err.message);
        }
    });

    // Сброс формы
    el('rr-reset').addEventListener('click', resetForm);

    // Глобальные функции для onclick в HTML
    window.editReactionRole = async (id) => {
        try {
            const res = await fetch(`/api/reaction-roles`);
            const list = await res.json();
            currentReactionRole = list.find(r => r.id === id);
            
            if (!currentReactionRole) {
                alert('Автороль не найдена');
                return;
            }

            titleInput.value = currentReactionRole.title;
            descInput.value = currentReactionRole.description || '';
            colorInput.value = currentReactionRole.color || '#5865F2';
            
            if (currentReactionRole.image) {
                uploadedImage = currentReactionRole.image;
                removeImageBtn.style.display = 'inline-block';
            } else {
                uploadedImage = null;
                removeImageBtn.style.display = 'none';
            }

            renderMappings();
            updatePreview();

            // Переключаем на вкладку создания
            tabs.forEach(t => t.classList.remove('active'));
            panes.forEach(p => p.classList.remove('active'));
            document.querySelector('[data-tab="create"]').classList.add('active');
            el('rr-pane-create').classList.add('active');
        } catch (err) {
            console.error('Ошибка загрузки автороли:', err);
            alert('Ошибка загрузки автороли: ' + err.message);
        }
    };

    window.deleteReactionRole = async (id) => {
        if (!confirm('Удалить эту автороль?')) return;

        try {
            const res = await fetch(`/api/reaction-roles/${id}`, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка удаления');

            loadReactionRoles();
        } catch (err) {
            console.error('Ошибка удаления:', err);
            alert('Ошибка удаления: ' + err.message);
        }
    };

    window.deleteMapping = async (mappingId) => {
        if (!currentReactionRole) return;

        try {
            const res = await fetch(`/api/reaction-roles/${currentReactionRole.id}/mappings/${mappingId}`, {
                method: 'DELETE'
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка удаления маппинга');

            // Обновляем текущую автороль
            currentReactionRole = await (await fetch(`/api/reaction-roles`)).json()
                .then(list => list.find(r => r.id === currentReactionRole.id));

            renderMappings();
            updatePreview();
        } catch (err) {
            console.error('Ошибка удаления маппинга:', err);
            alert('Ошибка удаления маппинга: ' + err.message);
        }
    };

    window.editMapping = async (mappingId) => {
        if (!currentReactionRole) return;

        const mapping = currentReactionRole.mappings.find(m => m.id === mappingId);
        if (!mapping) return;

        // Заполняем форму данными маппинга
        emojiInput.value = mapping.emoji;
        roleSelect.value = mapping.role_id;
        labelInput.value = mapping.label || '';
        
        // Устанавливаем режим редактирования
        editingMappingId = mappingId;
        el('rr-add-mapping').innerHTML = '<i class="bi bi-check-lg"></i>';
    };

    // Инициализация
    loadChannels();
    loadRoles();
    loadReactionRoles();
});

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}