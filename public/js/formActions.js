document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('embedBuilderContainer');
    if (!container) return;

    const guildId = container.getAttribute('data-guild-id');
    const roleChecklists = document.querySelectorAll('.role-checklist');
    if (!roleChecklists.length) return;

    let rolesCache = null;

    function renderChecklist(el, roles, selectedIds) {
        if (!roles.length) {
            el.innerHTML = '<span class="text-muted small">Роли не найдены</span>';
            return;
        }
        el.innerHTML = roles.map(r => `
            <div class="form-check">
                <input class="form-check-input role-checkbox" type="checkbox" value="${r.id}" id="role_${el.id}_${r.id}" ${selectedIds.includes(r.id) ? 'checked' : ''}>
                <label class="form-check-label small" for="role_${el.id}_${r.id}" style="color: ${r.color !== '#000000' ? r.color : '#d1d5db'};">
                    ${escapeHtml(r.name)}
                </label>
            </div>
        `).join('');
    }

    async function loadRoles() {
        try {
            const res = await fetch(`/api/guilds/${guildId}/roles`);
            const roles = await res.json();
            rolesCache = Array.isArray(roles) ? roles : [];

            roleChecklists.forEach(el => {
                let selectedIds = [];
                try {
                    selectedIds = JSON.parse(el.getAttribute('data-selected') || '[]');
                } catch (e) {
                    selectedIds = [];
                }
                renderChecklist(el, rolesCache, selectedIds);
            });
        } catch (err) {
            console.error('Ошибка загрузки ролей:', err);
            roleChecklists.forEach(el => {
                el.innerHTML = '<span class="text-muted small">Ошибка загрузки ролей</span>';
            });
        }
    }

    // Поиск/фильтр по спискам ролей
    document.querySelectorAll('.role-search').forEach(input => {
        input.addEventListener('input', () => {
            const targetId = input.getAttribute('data-target');
            const el = document.getElementById(targetId);
            if (!el) return;
            const query = input.value.trim().toLowerCase();
            el.querySelectorAll('.form-check').forEach(row => {
                const label = row.querySelector('label').textContent.trim().toLowerCase();
                row.style.display = label.includes(query) ? '' : 'none';
            });
        });
    });

    loadRoles();

    function getCheckedIds(el) {
        if (!el) return [];
        return Array.from(el.querySelectorAll('.role-checkbox:checked')).map(cb => cb.value);
    }

    // Собирает текущие автодействия — вызывается при сохранении (см. embedBuilder.js)
    window.getActionsData = function () {
        return {
            accept: {
                dm: document.getElementById('acceptDmInput')?.value.trim() || '',
                addRoles: getCheckedIds(document.getElementById('acceptAddRoles')),
                removeRoles: getCheckedIds(document.getElementById('acceptRemoveRoles'))
            },
            reject: {
                dm: document.getElementById('rejectDmInput')?.value.trim() || '',
                addRoles: getCheckedIds(document.getElementById('rejectAddRoles')),
                removeRoles: getCheckedIds(document.getElementById('rejectRemoveRoles'))
            }
        };
    };
});