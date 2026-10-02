// Редактор страницы клана. Состояние S целиком уходит на сервер кнопкой «Сохранить».
(async () => {
    const root = document.getElementById('clanEditor');
    if (!root) return;
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const e = escapeHtml;
    let S, roles = [], guildName = '';

    const get = p => p.split('.').reduce((o, k) => o && o[k], S);
    const set = (p, v) => { const a = p.split('.'), l = a.pop(); a.reduce((o, k) => o[k], S)[l] = v; };
    const uid = () => Math.random().toString(36).slice(2, 9);

    const BLANK = {
        history: () => ({ id: uid(), period: '', date: '', title: '', text: '', image: '' }),
        leaders: () => ({ id: uid(), name: '', role: '', bio: '', photo: '', discordId: '' }),
        staff: () => ({ id: uid(), name: '', role: '', bio: '', photo: '', discordId: '' }),
        gallery: () => ({ id: uid(), url: '', caption: '' })
    };

    const inp = (p, label, o = {}) => `<div class="mb-2"><label class="form-label small">${label}</label>${
        o.area ? `<textarea class="form-control" rows="${o.area}" data-k="${p}">${e(get(p) || '')}</textarea>`
               : `<input class="form-control" data-k="${p}" value="${e(get(p) || '')}" placeholder="${o.ph || ''}">`}</div>`;

    const pic = (p, label) => { const v = get(p); return `<div class="mb-2"><label class="form-label small">${label}</label><div class="d-flex align-items-center gap-2">
        ${v ? `<img src="${e(v)}" class="ce-thumb">` : ''}
        <label class="btn btn-sm btn-outline-light mb-0">Загрузить<input type="file" accept="image/*" hidden data-up="${p}"></label>
        ${v ? `<button type="button" class="btn btn-sm btn-outline-danger" data-clear="${p}">Убрать</button>` : ''}</div></div>`; };

    const imgSize = p => {
        if (!get(p + '.image')) return '';
        const w = get(p + '.imageWidth') || 100, a = get(p + '.imageAlign') || 'left';
        const opt = (v, t) => `<option value="${v}" ${a === v ? 'selected' : ''}>${t}</option>`;
        return `<div class="row align-items-center mb-2"><div class="col-md-7"><label class="form-label small">Размер картинки: <b data-out="${p}">${w}%</b> от ширины блока</label>
            <input type="range" class="form-range" min="10" max="100" step="5" value="${w}" data-k="${p}.imageWidth" data-size="${p}"></div>
            <div class="col-md-5"><label class="form-label small">Положение</label><select class="form-select form-select-sm" data-k="${p}.imageAlign">${opt('left', 'Слева')}${opt('center', 'По центру')}${opt('right', 'Справа')}</select></div></div>`;
    };

    const head = k => `<div class="row"><div class="col-md-6">${inp(`sections.${k}.title`, 'Заголовок раздела')}</div><div class="col-md-6">${inp(`sections.${k}.intro`, 'Вступление (необязательно)', { area: 2 })}</div></div>`;

    const items = (key, fields) => S[key].map((_, i) => `<div class="ce-item"><div class="d-flex justify-content-end gap-1 mb-2">
        <button type="button" class="btn btn-sm btn-outline-light" data-mv="${key}:${i}:-1">↑</button>
        <button type="button" class="btn btn-sm btn-outline-light" data-mv="${key}:${i}:1">↓</button>
        <button type="button" class="btn btn-sm btn-outline-danger" data-del="${key}:${i}">Удалить</button></div>${fields(`${key}.${i}`)}</div>`).join('')
        || '<p class="small text-muted mb-0">Пока пусто</p>';

    const addBtn = (key, label) => `<button type="button" class="btn btn-sm text-white" style="background:var(--accent-color)" data-add="${key}">+ ${label}</button>`;

    const person = p => `<div class="row"><div class="col-md-6">${inp(p + '.name', 'Имя / никнейм')}</div><div class="col-md-6">${inp(p + '.role', 'Должность')}</div></div>
        ${inp(p + '.bio', 'Биография', { area: 3 })}
        <div class="row"><div class="col-md-6">${pic(p + '.photo', 'Фото')}</div><div class="col-md-6">${inp(p + '.discordId', 'Discord ID (необязательно)', { ph: 'аватар подтянется сам, если нет фото' })}</div></div>`;

    function render() {
        root.innerHTML = `
        <div class="ce-bar"><div><h3 class="fw-bold text-white mb-0">Страница клана</h3><span class="small text-muted">Публичный сайт: <a href="/" target="_blank">открыть</a></span></div>
            <button type="button" class="btn text-white fw-semibold px-4" style="background:var(--accent-color)" id="ceSave">Сохранить всё</button></div>

        <div class="ce-card"><h5 class="mb-3">Главный экран</h5>${inp('hero.title', 'Название клана')}${inp('hero.subtitle', 'Слоган')}${inp('hero.primaryText', 'Текст главной кнопки')}</div>
        <div class="ce-card"><h5 class="mb-3">О клане</h5>${inp('about.title', 'Заголовок')}${inp('about.text', 'Текст (пустой — блок скрыт)', { area: 5 })}</div>

        <div class="ce-card"><h5 class="mb-3">История клана</h5>${head('history')}
            <div class="small text-muted mb-3">Поле «Период» объединяет события в группу: подряд идущие события с одинаковым периодом показываются под общим заголовком. Переносы строк сохраняются, поэтому текст из чата можно вставлять как есть.</div>
            ${items('history', p => `<div class="row"><div class="col-md-5">${inp(p + '.period', 'Период (например «Основание»)')}</div><div class="col-md-3">${inp(p + '.date', 'Дата')}</div><div class="col-md-4">${inp(p + '.title', 'Заголовок события')}</div></div>${inp(p + '.text', 'Текст', { area: 5 })}${pic(p + '.image', 'Картинка')}${imgSize(p)}`)}
            ${addBtn('history', 'Добавить событие')}</div>

        <div class="ce-card"><h5 class="mb-3">Руководство</h5>${head('leaders')}${items('leaders', person)}${addBtn('leaders', 'Добавить')}</div>
        <div class="ce-card"><h5 class="mb-3">Заместители и администрация</h5>${head('staff')}${items('staff', person)}${addBtn('staff', 'Добавить человека')}</div>

        <div class="ce-card"><h5 class="mb-3">Основа клана (из Discord)</h5>${head('members')}
            <label class="form-label small">Роль${guildName ? ` на сервере «${e(guildName)}»` : ''}</label>
            <select class="form-select" data-k="sections.members.roleId"><option value="">— не показывать раздел —</option>${roles.map(r => `<option value="${r.id}" ${r.id === S.sections.members.roleId ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</select>
            <div class="small text-muted mt-2">Список обновляется автоматически: роль выдали — человек появился, забрали — исчез.</div></div>

        <div class="ce-card"><h5 class="mb-3">Галерея</h5>${head('gallery')}
            <div class="row g-2 mb-3">${S.gallery.map((g, i) => `<div class="col-md-4"><div class="ce-item"><img src="${e(g.url)}" class="w-100 mb-2" style="border-radius:8px"><input class="form-control form-control-sm mb-2" data-k="gallery.${i}.caption" value="${e(g.caption)}" placeholder="Подпись"><div class="d-flex gap-1"><button type="button" class="btn btn-sm btn-outline-light" data-mv="gallery:${i}:-1">←</button><button type="button" class="btn btn-sm btn-outline-light" data-mv="gallery:${i}:1">→</button><button type="button" class="btn btn-sm btn-outline-danger ms-auto" data-del="gallery:${i}">Удалить</button></div></div></div>`).join('')}</div>
            <label class="btn btn-sm text-white mb-0" style="background:var(--accent-color)">+ Загрузить фото<input type="file" accept="image/*" multiple hidden data-gal="true"></label></div>

        <div class="ce-card"><h5 class="mb-3">Сервер</h5>${inp('guildId', 'ID сервера клана', { ph: 'пусто = сервер по умолчанию из «Настроек»' })}
            <div class="small text-muted">Сменили ID: сохраните и обновите страницу, чтобы загрузился список ролей нового сервера.</div></div>`;
        console.log('[render] HTML обновлён, ищем input с data-gal:', root.querySelector('[data-gal]'));
    }

    async function upload(file) {
        console.log('[upload] 开始上传:', file.name, file.size);
        const fd = new FormData(); fd.append('image', file);
        console.log('[upload] отправка запроса на /api/clan/upload');
        const r = await fetch('/api/clan/upload', { method: 'POST', body: fd });
        console.log('[upload] ответ получен, статус:', r.status);
        const j = await r.json();
        console.log('[upload] ответ сервера:', j);
        if (!r.ok) throw new Error(j.error || 'Ошибка загрузки');
        return j.url;
    }

    root.addEventListener('input', ev => {
        const t = ev.target;
        if (t.dataset.k) set(t.dataset.k, t.value);
        if (t.dataset.size) root.querySelector(`[data-out="${t.dataset.size}"]`).textContent = t.value + '%';
    });

    root.addEventListener('change', async ev => {
        const t = ev.target;
        console.log('[change] событие сработало, target:', t);
        console.log('[change] dataset:', t.dataset);
        console.log('[change] has dataset.up:', !!t.dataset.up);
        console.log('[change] has dataset.gal:', !!t.dataset.gal);
        console.log('[change] files:', t.files);
        console.log('[change] files.length:', t.files?.length);
        console.log('[change] проверка условия галереи:', !!t.dataset.gal, '&&', !!t.files, '&&', t.files?.length > 0);
        try {
            if (t.dataset.up && t.files && t.files[0]) {
                console.log('[change] загрузка одиночного фото');
                const url = await upload(t.files[0]);
                console.log('[change] URL получен:', url);
                set(t.dataset.up, url);
                console.log('[change] значение установлено, ререндер');
                render();
            }
            if (t.dataset.gal && t.files && t.files.length > 0) {
                console.log('[change] === ЗАХОДИМ В ГАЛЕРЕЮ ===');
                console.log('[change] загрузка в галерею, файлов:', t.files.length);
                for (const f of t.files) {
                    const url = await upload(f);
                    console.log('[change] фото загружено, URL:', url);
                    S.gallery.push({ id: uid(), url: url, caption: '' });
                }
                console.log('[change] все фото добавлены, ререндер');
                render();
            }
        } catch (err) {
            console.error('[change] ошибка:', err);
            alert(err.message);
        }
    });

    root.addEventListener('click', async ev => {
        const t = ev.target.closest('button'); if (!t) return;
        const d = t.dataset;
        if (d.add) { S[d.add].push(BLANK[d.add]()); render(); }
        else if (d.del) { const [k, i] = d.del.split(':'); if (confirm('Удалить?')) { S[k].splice(+i, 1); render(); } }
        else if (d.mv) { const [k, i, s] = d.mv.split(':'), a = S[k], j = +i + +s; if (j >= 0 && j < a.length) { [a[i], a[j]] = [a[j], a[i]]; render(); } }
        else if (d.clear) { set(d.clear, ''); render(); }
        else if (t.id === 'ceSave') {
            t.disabled = true;
            try {
                const r = await fetch('/api/clan', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S) });
                const j = await r.json(); if (!r.ok) throw new Error(j.error);
                S = j; render(); alert('Сохранено');
            } catch (err) { alert('Ошибка: ' + err.message); t.disabled = false; }
        }
    });

    S = await (await fetch('/api/clan')).json();
    try { const r = await (await fetch('/api/clan/roles')).json(); roles = r.roles; guildName = r.guildName; } catch { /* бот ещё не готов */ }
    render();
})();