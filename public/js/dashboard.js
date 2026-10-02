// Живой предпросмотр Discord Embed
function initEmbedPreview() {
    const titleInput = document.getElementById('embedTitle');
    const descInput = document.getElementById('embedDescription');
    const colorInput = document.getElementById('embedColor');
    const authorInput = document.getElementById('embedAuthor');
    const urlInput = document.getElementById('imageUrl');
    const fileInput = document.getElementById('imageFileUpload');

    const previewEmbed = document.getElementById('previewEmbed');
    const previewTitle = document.getElementById('previewTitle');
    const previewDesc = document.getElementById('previewDescription');
    const previewAuthor = document.getElementById('previewAuthor');
    const previewImgWrapper = document.getElementById('previewImageWrapper');
    const previewImg = document.getElementById('previewImage');

    // Если элементов формы нет на странице, выходим
    if (!titleInput || !previewTitle) return;

    function updatePreview() {
        // Заголовок
        previewTitle.textContent = titleInput.value.trim() || 'Заголовок объявления';

        // Описание
        if (descInput) {
            previewDesc.textContent = descInput.value.trim() || 'Текст сообщения...';
        }

        // Цвет рамки эмбеда
        if (colorInput && previewEmbed) {
            previewEmbed.style.borderLeftColor = colorInput.value;
        }

        // Автор
        if (authorInput && previewAuthor) {
            const authorVal = authorInput.value.trim();
            if (authorVal) {
                previewAuthor.textContent = authorVal;
                previewAuthor.style.display = 'block';
            } else {
                previewAuthor.style.display = 'none';
            }
        }

        // Картинка по URL
        if (urlInput && urlInput.value.trim()) {
            previewImg.src = urlInput.value.trim();
            if (previewImgWrapper) previewImgWrapper.style.display = 'block';
        } else if (!fileInput || !fileInput.files || !fileInput.files[0]) {
            if (previewImgWrapper) previewImgWrapper.style.display = 'none';
        }
    }

    // Вешаем слушатели событий на все поля ввода
    const inputs = [titleInput, descInput, colorInput, authorInput, urlInput];
    inputs.forEach(input => {
        if (input) {
            input.addEventListener('input', updatePreview);
            input.addEventListener('keyup', updatePreview);
            input.addEventListener('change', updatePreview);
        }
    });

    // Обработка загрузки файла с устройства
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

    // Первичный запуск для отображения текущих значений
    updatePreview();
    console.log('Discord Embed Preview initialized successfully.');
}

// Запускаем инициализацию сразу или после загрузки DOM
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEmbedPreview);
} else {
    initEmbedPreview();
}