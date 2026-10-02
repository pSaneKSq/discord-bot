document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('swearWordsPage');
    if (!page) return;

    const wordInput = document.getElementById('swWordInput');
    const addBtn = document.getElementById('swAddBtn');
    const wordsList = document.getElementById('swWordsList');
    const countBadge = document.getElementById('swCount');
    const alertEl = document.getElementById('swAlert');

    let words = [];

    function showAlert(message, type = 'danger') {
        alertEl.textContent = message;
        alertEl.className = `alert py-2 small mb-3 alert-${type}`;
        alertEl.style.display = 'block';
        setTimeout(() => {
            alertEl.style.display = 'none';
        }, 5000);
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function renderWords() {
        if (!words.length) {
            wordsList.innerHTML = '<div class="sw-empty">Список пуст. Добавьте первое слово выше.</div>';
            countBadge.textContent = '0 слов';
            return;
        }

        wordsList.innerHTML = words.map(word => `
            <div class="sw-word-item">
                <span class="sw-word-text">${escapeHtml(word)}</span>
                <button class="btn btn-sm btn-outline-danger" data-word="${escapeHtml(word)}">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        `).join('');

        countBadge.textContent = `${words.length} слов${words.length !== 1 ? 'а' : ''}`;
    }

    async function loadWords() {
        try {
            const res = await fetch('/api/swear-words');
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка загрузки');
            words = Array.isArray(data) ? data : [];
            renderWords();
        } catch (err) {
            console.error('Ошибка загрузки списка матов:', err);
            showAlert('Не удалось загрузить список матов');
        }
    }

    async function addWord() {
        const word = wordInput.value.trim();
        if (!word) {
            showAlert('Введите слово');
            return;
        }
        if (word.length > 100) {
            showAlert('Слово слишком длинное (максимум 100 символов)');
            return;
        }

        addBtn.disabled = true;
        try {
            const res = await fetch('/api/swear-words', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ word })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Не удалось добавить слово');
            }
            wordInput.value = '';
            await loadWords();
            showAlert('Слово добавлено', 'success');
        } catch (err) {
            console.error('Ошибка добавления слова:', err);
            showAlert(err.message || 'Не удалось добавить слово');
        } finally {
            addBtn.disabled = false;
        }
    }

    async function deleteWord(word) {
        if (!confirm(`Удалить слово "${word}" из списка?`)) return;

        try {
            const res = await fetch(`/api/swear-words/${encodeURIComponent(word)}`, {
                method: 'DELETE'
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Не удалось удалить слово');
            }
            await loadWords();
            showAlert('Слово удалено', 'success');
        } catch (err) {
            console.error('Ошибка удаления слова:', err);
            showAlert(err.message || 'Не удалось удалить слово');
        }
    }

    addBtn.addEventListener('click', addWord);
    wordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addWord();
        }
    });

    wordsList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-word]');
        if (btn) {
            deleteWord(btn.dataset.word);
        }
    });

    loadWords();
});
