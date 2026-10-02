document.addEventListener('DOMContentLoaded', () => {
    const titleInput = document.getElementById('embedTitleInput');
    const colorInput = document.getElementById('embedColorInput');
    const descInput = document.getElementById('embedDescInput');
    const authorInput = document.getElementById('embedAuthorInput');
    const urlInput = document.getElementById('imageUrl');
    const fileInput = document.getElementById('imageFileUpload');
    const buttonTextInput = document.getElementById('embedButtonText');

    const discordEmbedPreview = document.getElementById('discordEmbedPreview');
    const prevTitle = document.getElementById('prevTitle');
    const prevDesc = document.getElementById('prevDesc');
    const prevAuthor = document.getElementById('prevAuthor');
    const prevBtnText = document.getElementById('prevBtnText');
    const previewImgWrapper = document.getElementById('previewImageWrapper');
    const previewImg = document.getElementById('previewImage');

    if (!titleInput) return;

    function updatePreview() {
        if (prevTitle) {
            prevTitle.textContent = titleInput.value.trim() || 'Заголовок объявления';
        }
        if (prevDesc) {
            prevDesc.textContent = descInput.value.trim() || 'Текст сообщения...';
        }
        if (prevBtnText) {
            prevBtnText.textContent = buttonTextInput.value.trim() || 'Подать заявку';
        }
        if (discordEmbedPreview && colorInput) {
            discordEmbedPreview.style.borderLeftColor = colorInput.value;
        }

        if (authorInput && prevAuthor) {
            const authorVal = authorInput.value.trim();
            if (authorVal) {
                prevAuthor.textContent = authorVal;
                prevAuthor.style.display = 'block';
            } else {
                prevAuthor.style.display = 'none';
            }
        }

        if (urlInput && urlInput.value.trim()) {
            previewImg.src = urlInput.value.trim();
            if (previewImgWrapper) previewImgWrapper.style.display = 'block';
        } else if (!fileInput || !fileInput.files || !fileInput.files[0]) {
            if (previewImgWrapper) previewImgWrapper.style.display = 'none';
        }
    }

    const inputs = [titleInput, descInput, colorInput, authorInput, urlInput, buttonTextInput];
    inputs.forEach(input => {
        if (input) {
            input.addEventListener('input', updatePreview);
            input.addEventListener('keyup', updatePreview);
            input.addEventListener('change', updatePreview);
        }
    });

    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    if (previewImg) previewImg.src = event.target.result;
                    if (previewImgWrapper) previewImgWrapper.style.display = 'block';
                };
                reader.readAsDataURL(file);
            } else {
                updatePreview();
            }
        });
    }

    // Обработка нажатия на кнопку «Сохранить всё»
    const saveBtn = document.getElementById('saveEmbedBtn');
    const container = document.getElementById('embedBuilderContainer');

    if (saveBtn && container) {
        saveBtn.addEventListener('click', async () => {
            const formId = container.getAttribute('data-form-id');

            // Базовые поля эмбеда
            const payload = {
                channelId: document.getElementById('channelIdInput')?.value.trim() || '',
                messageId: document.getElementById('messageIdInput')?.value.trim() || '',
                embedTitle: titleInput.value.trim(),
                embedDesc: descInput.value,
                embedColor: colorInput.value,
                embedAuthor: authorInput ? authorInput.value.trim() : '',
                imageUrl: urlInput ? urlInput.value.trim() : '',
                buttonText: buttonTextInput.value.trim()
            };

            // Добавляем данные из остальных вкладок, если их скрипты успели загрузиться
            if (typeof window.getQuestionsData === 'function') {
                payload.questions = window.getQuestionsData();
            }
            if (typeof window.getSettingsData === 'function') {
                payload.settings = window.getSettingsData();
            }
            if (typeof window.getActionsData === 'function') {
                payload.actions = window.getActionsData();
            }

            try {
                saveBtn.disabled = true;
                saveBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Сохранение...`;

                const response = await fetch(`/api/forms/${formId}/update`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await response.json();

                if (data.success) {
                    alert('Форма успешно сохранена!');
                    window.location.href = '/dashboard?tab=forms';
                } else {
                    alert('Ошибка при сохранении: ' + (data.error || data.message || 'Неизвестная ошибка'));
                    saveBtn.disabled = false;
                    saveBtn.innerHTML = `<i class="bi bi-save-fill me-1"></i> Сохранить всё`;
                }
            } catch (err) {
                console.error(err);
                alert('Ошибка соединения с сервером');
                saveBtn.disabled = false;
                saveBtn.innerHTML = `<i class="bi bi-save-fill me-1"></i> Сохранить всё`;
            }
        });
    }

    updatePreview();
});