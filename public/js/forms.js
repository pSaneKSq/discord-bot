document.addEventListener('DOMContentLoaded', () => {
    // Модалка создания
    const openBtn = document.getElementById('openCreateModalBtn');
    const overlay = document.getElementById('customModalOverlay');
    const closeX = document.getElementById('closeModalX');
    const closeBtn = document.getElementById('closeModalBtn');
    const saveBtn = document.getElementById('saveNewFormBtn');
    const nameInput = document.getElementById('newFormName');
    const channelInput = document.getElementById('newFormChannel');
    const formsContainer = document.getElementById('formsListContainer');

    // Модалка публикации
    const publishOverlay = document.getElementById('publishModalOverlay');
    const closePublishX = document.getElementById('closePublishModalX');
    const closePublishBtn = document.getElementById('closePublishModalBtn');
    const confirmPublishBtn = document.getElementById('confirmPublishBtn');
    const publishChannelSelect = document.getElementById('publishChannelSelect');
    
    let currentCardToPublish = null;
    let currentFormId = null;
    
    // ID сервера (берем из атрибута на странице или заменяем на ваш ID)
    const formsPageContainer = document.getElementById('formsPageContainer');
    const currentGuildId = formsPageContainer ? formsPageContainer.dataset.guildId : "ТВОЙ_GUILD_ID_СЕРВЕРА";

    // Открытие модалки создания
    if (openBtn && overlay) {
        openBtn.addEventListener('click', () => {
            overlay.style.display = 'flex';
            if (nameInput) nameInput.focus();
        });
    }

    function closeModal() {
        if (overlay) overlay.style.display = 'none';
        if (nameInput) nameInput.value = '';
        if (channelInput) channelInput.value = '';
    }

    if (closeX) closeX.addEventListener('click', closeModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });
    }

    // Функция загрузки каналов с сервера
    async function loadDiscordChannels() {
        if (!publishChannelSelect) return;
        publishChannelSelect.innerHTML = '<option value="" selected disabled>Загрузка каналов...</option>';
        
        try {
            const response = await fetch(`/api/guilds/${currentGuildId}/channels`);
            const channels = await response.json();

            if (channels && channels.length > 0) {
                publishChannelSelect.innerHTML = '<option value="" selected disabled>-- Выберите канал --</option>';
                channels.forEach(channel => {
                    const option = document.createElement('option');
                    option.value = channel.id;
                    option.textContent = `# ${channel.name}`;
                    publishChannelSelect.appendChild(option);
                });
            } else {
                publishChannelSelect.innerHTML = '<option value="" selected disabled>Каналы не найдены</option>';
            }
        } catch (err) {
            console.error('Ошибка загрузки каналов:', err);
            publishChannelSelect.innerHTML = '<option value="" selected disabled>Ошибка загрузки каналов</option>';
        }
    }

    // Открытие модалки публикации при клике на «Опубликовать»
    document.addEventListener('click', (e) => {
        const pubBtn = e.target.closest('.publish-form-btn');
        if (pubBtn) {
            currentCardToPublish = pubBtn.closest('.form-card-wrapper');
            currentFormId = currentCardToPublish ? currentCardToPublish.dataset.formId : '1';
            
            if (publishOverlay) {
                publishOverlay.style.display = 'flex';
                loadDiscordChannels(); // Автоматически подтягиваем актуальные каналы из Discord!
            }
        }
    });

    function closePublishModal() {
        if (publishOverlay) publishOverlay.style.display = 'none';
        currentCardToPublish = null;
        currentFormId = null;
    }

    if (closePublishX) closePublishX.addEventListener('click', closePublishModal);
    if (closePublishBtn) closePublishBtn.addEventListener('click', closePublishModal);
    if (publishOverlay) {
        publishOverlay.style.display = 'click' && publishOverlay.addEventListener('click', (e) => {
            if (e.target === publishOverlay) closePublishModal();
        });
    }

    // Подтверждение публикации и отправка на сервер бэкенда
    if (confirmPublishBtn) {
        confirmPublishBtn.addEventListener('click', async () => {
            const selectedOption = publishChannelSelect ? publishChannelSelect.options[publishChannelSelect.selectedIndex] : null;
            const selectedChannelId = publishChannelSelect ? publishChannelSelect.value : '';
            
            if (!selectedChannelId) {
                alert('Пожалуйста, выберите канал для публикации!');
                return;
            }

            confirmPublishBtn.disabled = true;
            confirmPublishBtn.textContent = 'Публикация...';

            try {
                const res = await fetch(`/api/forms/${currentFormId}/publish`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ channelId: selectedChannelId })
                });
                
                const data = await res.json();

                if (res.ok && data.success) {
                    const channelNameText = selectedOption ? selectedOption.text : `# ${selectedChannelId}`;

                    if (currentCardToPublish) {
                        currentCardToPublish.dataset.status = 'published';
                        
                        const badgeContainer = currentCardToPublish.querySelector('.status-badge-container');
                        if (badgeContainer) {
                            badgeContainer.style.background = 'rgba(34, 197, 94, 0.1)';
                            badgeContainer.style.border = '1px solid rgba(34, 197, 94, 0.2)';
                            badgeContainer.innerHTML = '<span class="text-success small fw-semibold">● Опубликовано</span>';
                        }

                        const channelDisplay = currentCardToPublish.querySelector('.channel-display');
                        if (channelDisplay) {
                            channelDisplay.className = 'channel-display text-accent small fw-medium';
                            channelDisplay.textContent = `<${channelNameText}>`;
                        }

                        const msgIdDisplay = currentCardToPublish.querySelector('.msgid-display');
                        if (msgIdDisplay) {
                            msgIdDisplay.className = 'msgid-display text-white small fw-medium';
                            msgIdDisplay.style.fontFamily = 'monospace';
                            msgIdDisplay.textContent = data.messageId;
                        }

                        updateCounters();
                    }
                    closePublishModal();
                } else {
                    alert('Ошибка при публикации: ' + (data.error || 'Неизвестная ошибка'));
                }
            } catch (err) {
                console.error(err);
                alert('Не удалось отправить запрос на сервер.');
            } finally {
                confirmPublishBtn.disabled = false;
                confirmPublishBtn.textContent = 'Опубликовать';
            }
        });
    }

    function updateCounters() {
        const wrappers = document.querySelectorAll('.form-card-wrapper');
        let published = 0;
        let drafts = 0;
        wrappers.forEach(w => {
            if (w.dataset.status === 'published') published++;
            else drafts++;
        });
        document.getElementById('statTotal').textContent = wrappers.length;
        document.getElementById('statPublished').textContent = published;
        document.getElementById('statDrafts').textContent = drafts;
    }

    // Удаление формы
    document.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.delete-form-btn');
        if (deleteBtn) {
            if (confirm('Вы уверены, что хотите удалить эту форму?')) {
                const card = deleteBtn.closest('.form-card-wrapper');
                if (card) {
                    card.remove();
                    updateCounters();
                }
            }
        }
    });

    // Создание новой формы
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const name = nameInput ? nameInput.value.trim() : '';
            const channel = channelInput ? channelInput.value.trim() : '';

            if (!name) {
                alert('Пожалуйста, введите название формы!');
                if (nameInput) nameInput.focus();
                return;
            }

            const channelText = channel ? `&lt;#${channel}&gt;` : 'Не указан';
            
            const newCardHtml = `
            <div class="col-xl-6 form-card-wrapper" data-status="draft" data-form-id="new_${Date.now()}">
                <div class="glass-card p-4 h-d-flex flex-column justify-content-between" style="border: 1px solid rgba(255, 255, 255, 0.08);">
                    <div>
                        <div class="d-flex align-items-center justify-content-between mb-3">
                            <div class="d-flex align-items-center gap-2">
                                <i class="bi bi-file-earmark-text text-warning fs-5"></i>
                                <h5 class="fw-bold text-white mb-0">${escapeHtml(name)}</h5>
                            </div>
                            <div class="status-badge-container d-flex align-items-center gap-2 px-3 py-1 rounded-pill" style="background: rgba(234, 179, 8, 0.1); border: 1px solid rgba(234, 179, 8, 0.2);">
                                <span class="text-warning small fw-semibold">● Черновик</span>
                            </div>
                        </div>

                        <div class="row g-2 mb-4 p-3 rounded-3" style="background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.03);">
                            <div class="col-12 mb-2">
                                <span class="text-muted d-block" style="font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px;">Канал для проверки</span>
                                <span class="channel-display ${channel ? 'text-accent' : 'text-muted'} small fw-medium">${channelText}</span>
                            </div>
                            <div class="col-6">
                                <span class="text-muted d-block" style="font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px;">Количество вопросов</span>
                                <span class="text-white small fw-medium">0 Вопросов</span>
                            </div>
                            <div class="col-6">
                                <span class="text-muted d-block" style="font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px;">ID Сообщения</span>
                                <span class="msgid-display text-muted small fw-medium">—</span>
                            </div>
                        </div>
                    </div>

                    <div class="d-flex align-items-center gap-2 pt-2 border-top border-secondary border-opacity-10">
                        <button class="btn btn-sm btn-accent px-3 text-white fw-semibold publish-form-btn"><i class="bi bi-send-fill me-1"></i> Опубликовать</button>
                        <button class="btn btn-sm btn-dark px-3 text-light" style="background: rgba(255,255,255,0.08);"><i class="bi bi-pencil-fill me-1"></i> Редактировать</button>
                        <button class="btn btn-sm btn-outline-danger px-2 ms-auto delete-form-btn" title="Удалить"><i class="bi bi-trash-fill"></i></button>
                    </div>
                </div>
            </div>`;

            if (formsContainer) {
                formsContainer.insertAdjacentHTML('afterbegin', newCardHtml);
                updateCounters();
            }

            closeModal();
        });
    }
});