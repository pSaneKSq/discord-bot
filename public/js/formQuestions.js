document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('questionsListContainer');
    const addBtn = document.getElementById('addQuestionBtn');
    const noQuestionsMsg = document.getElementById('noQuestionsMsg');
    const countBadge = document.getElementById('questionsCountBadge');
    const pagesHint = document.getElementById('questionsPagesHint');
    if (!container || !addBtn) return;

    // ⚠️ Эти значения продублированы в tickets.js (MAX_QUESTIONS, QUESTIONS_PER_MODAL) — меняй в обоих местах.
    const MAX_QUESTIONS = 20;
    const QUESTIONS_PER_MODAL = 5;

    // Обновляет всё, что зависит от количества вопросов: пустое сообщение, счётчик,
    // подсказку про шаги в Discord и доступность кнопки «Добавить вопрос»
    function refreshState() {
        const count = container.querySelectorAll('.question-row').length;

        if (noQuestionsMsg) {
            noQuestionsMsg.style.display = count ? 'none' : 'block';
        }

        if (countBadge) {
            countBadge.textContent = count;
        }

        if (pagesHint) {
            if (count === 0) {
                pagesHint.textContent = '';
            } else if (count <= QUESTIONS_PER_MODAL) {
                pagesHint.textContent = 'Все вопросы уместятся в одном окне Discord.';
            } else {
                const pages = Math.ceil(count / QUESTIONS_PER_MODAL);
                pagesHint.textContent = `Шагов заполнения в Discord: ${pages} (по ${QUESTIONS_PER_MODAL} вопросов на шаг, между шагами — кнопка «Продолжить»).`;
            }
        }

        const limitReached = count >= MAX_QUESTIONS;
        addBtn.disabled = limitReached;
        addBtn.title = limitReached ? `Достигнут максимум — ${MAX_QUESTIONS} вопросов` : '';
        addBtn.style.opacity = limitReached ? '0.5' : '';
    }

    function makeQuestionRow(data = {}) {
        const id = data.id || ('q_' + Date.now() + '_' + Math.floor(Math.random() * 1000));
        const wrapper = document.createElement('div');
        wrapper.className = 'question-row p-3 rounded-3';
        wrapper.setAttribute('data-question-id', id);
        wrapper.style.background = '#121318';
        wrapper.style.border = '1px solid rgba(255, 255, 255, 0.08)';

        wrapper.innerHTML = `
            <div class="d-flex align-items-center justify-content-between mb-2">
                <span class="text-muted small fw-semibold">Вопрос</span>
                <button type="button" class="btn btn-sm btn-outline-danger delete-question-btn" title="Удалить вопрос">
                    <i class="bi bi-trash-fill"></i>
                </button>
            </div>
            <div class="mb-2">
                <label class="form-label text-muted small">Текст вопроса</label>
                <input type="text" class="form-control question-label" value="${escapeHtml(data.label || '')}" style="background: #0f1015; border: 1px solid rgba(255,255,255,0.1); color: #fff;">
            </div>
            <div class="mb-2">
                <label class="form-label text-muted small">Плейсхолдер (подсказка в пустом поле)</label>
                <input type="text" class="form-control question-placeholder" value="${escapeHtml(data.placeholder || '')}" style="background: #0f1015; border: 1px solid rgba(255,255,255,0.1); color: #fff;">
            </div>
            <div class="row g-2">
                <div class="col-4">
                    <label class="form-label text-muted small">Мин. длина ответа</label>
                    <input type="number" min="0" class="form-control question-min" value="${data.minLength ?? 0}" style="background: #0f1015; border: 1px solid rgba(255,255,255,0.1); color: #fff;">
                </div>
                <div class="col-4">
                    <label class="form-label text-muted small">Макс. длина ответа</label>
                    <input type="number" min="1" max="4000" class="form-control question-max" value="${data.maxLength ?? 500}" style="background: #0f1015; border: 1px solid rgba(255,255,255,0.1); color: #fff;">
                </div>
                <div class="col-4 d-flex align-items-end">
                    <div class="form-check form-switch">
                        <input class="form-check-input question-required" type="checkbox" role="switch" ${data.required ? 'checked' : ''}>
                        <label class="form-check-label text-muted small">Обязательный</label>
                    </div>
                </div>
            </div>
        `;

        wrapper.querySelector('.delete-question-btn').addEventListener('click', () => {
            wrapper.remove();
            refreshState();
        });

        return wrapper;
    }

    // Навешиваем удаление на уже отрендеренные сервером вопросы
    container.querySelectorAll('.delete-question-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.closest('.question-row').remove();
            refreshState();
        });
    });

    addBtn.addEventListener('click', () => {
        if (container.querySelectorAll('.question-row').length >= MAX_QUESTIONS) return;
        const row = makeQuestionRow();
        container.appendChild(row);
        refreshState();
    });

    // Собирает текущие вопросы из формы — вызывается при сохранении (см. embedBuilder.js)
    window.getQuestionsData = function () {
        return Array.from(container.querySelectorAll('.question-row')).map(row => ({
            id: row.getAttribute('data-question-id'),
            label: row.querySelector('.question-label').value.trim(),
            placeholder: row.querySelector('.question-placeholder').value.trim(),
            minLength: parseInt(row.querySelector('.question-min').value, 10) || 0,
            maxLength: parseInt(row.querySelector('.question-max').value, 10) || 500,
            required: row.querySelector('.question-required').checked
        }));
    };

    refreshState();
});