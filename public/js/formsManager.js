document.addEventListener('DOMContentLoaded', () => {
    // 1. Кнопка «Создать форму»
    const createBtn = document.getElementById('createNewFormBtn');
    if (createBtn) {
        createBtn.addEventListener('click', async () => {
            try {
                const response = await fetch('/api/forms/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                const data = await response.json();
                if (data.success && data.formId) {
                    window.location.href = `/dashboard?tab=editForm&id=${data.formId}`;
                } else {
                    alert('Ошибка при создании формы');
                }
            } catch (err) {
                console.error(err);
                alert('Не удалось отправить запрос на сервер');
            }
        });
    }

    // 2. Кнопки «Опубликовать» в карточках
    document.querySelectorAll('.publish-form-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const cardWrapper = e.target.closest('.form-card-wrapper');
            const formId = cardWrapper ? cardWrapper.getAttribute('data-form-id') : null;
            if (!formId) return;

            try {
                btn.disabled = true;
                btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Публикация...`;

                // Канал не спрашиваем — сервер берёт уже сохранённый ID из редактора формы
                const response = await fetch(`/api/forms/${formId}/publish`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                const data = await response.json();

                if (data.success) {
                    alert('Форма успешно опубликована в Discord!');
                    location.reload();
                } else {
                    alert('Ошибка публикации: ' + (data.error || data.message || 'сначала укажите ID канала в редакторе формы'));
                    btn.disabled = false;
                    btn.innerHTML = `<i class="bi bi-send-fill me-1"></i> Опубликовать`;
                }
            } catch (err) {
                console.error(err);
                alert('Ошибка соединения с сервером');
                btn.disabled = false;
                btn.innerHTML = `<i class="bi bi-send-fill me-1"></i> Опубликовать`;
            }
        });
    });

    // 3. Кнопки удаления
    document.querySelectorAll('.delete-form-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Вы уверены, что хотите удалить эту форму?')) return;

            const card = btn.closest('.form-card-wrapper');
            const formId = card ? card.getAttribute('data-form-id') : null;
            if (!formId) return;

            try {
                btn.disabled = true;
                const response = await fetch(`/api/forms/${formId}/delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                const data = await response.json();

                if (data.success) {
                    card.remove();
                } else {
                    alert('Ошибка при удалении: ' + (data.error || 'неизвестная ошибка'));
                    btn.disabled = false;
                }
            } catch (err) {
                console.error(err);
                alert('Ошибка соединения с сервером');
                btn.disabled = false;
            }
        });
    });
});