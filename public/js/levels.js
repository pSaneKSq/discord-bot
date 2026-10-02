document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('levelsPage');
    if (!page) return;

    const guildId = page.getAttribute('data-guild-id');
    const el = (id) => document.getElementById(id);

    // Элементы настроек
    const enabledCheckbox = el('lvl-enabled');
    const xpMinInput = el('lvl-xp-min');
    const xpMaxInput = el('lvl-xp-max');
    const cooldownInput = el('lvl-cooldown');
    const modeSelect = el('lvl-mode');
    const channelSelect = el('lvl-channel');
    const messageInput = el('lvl-message');
    const addRoleSelect = el('lvl-add-role-select');
    const addChannelSelect = el('lvl-add-channel-select');
    const noXpRolesList = el('lvl-no-xp-roles-list');
    const noXpChannelsList = el('lvl-no-xp-channels-list');

    // Элементы наград
    const rewardLevelInput = el('lvl-reward-level');
    const rewardRoleSelect = el('lvl-reward-role');
    const removePreviousCheckbox = el('lvl-remove-previous');
    const rewardsList = el('lvl-rewards-list');

    // Хранилище для данных
    let noXpRoles = [];
    let noXpChannels = [];
    let allRoles = [];
    let allChannels = [];

    // Формула расчета XP для уровня (MEE6 формула)
    function calculateXpForLevel(level) {
        if (level === 0) return 0;
        return 5 * Math.pow(level, 2) + 50 * level + 100;
    }

    // Расчет прогресса до следующего уровня
    function calculateLevelProgress(xp, level) {
        const currentLevelXp = calculateXpForLevel(level);
        const nextLevelXp = calculateXpForLevel(level + 1);
        const xpInCurrentLevel = xp - currentLevelXp;
        const xpNeededForNext = nextLevelXp - currentLevelXp;
        const percentage = Math.min(100, Math.max(0, (xpInCurrentLevel / xpNeededForNext) * 100));

        return {
            current: xpInCurrentLevel,
            needed: xpNeededForNext,
            percentage: percentage,
            toNextLevel: nextLevelXp - xp
        };
    }

    // Табы
    const tabs = document.querySelectorAll('.lvl-tab');
    const panes = document.querySelectorAll('.lvl-pane');

    // Переключение табов
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.getAttribute('data-tab');
            
            tabs.forEach(t => t.classList.remove('active'));
            panes.forEach(p => p.classList.remove('active'));
            
            tab.classList.add('active');
            el(`lvl-pane-${tabName}`).classList.add('active');

            if (tabName === 'leaderboard') {
                loadLeaderboard();
            } else if (tabName === 'stats') {
                loadStats();
            } else if (tabName === 'rewards') {
                if (allRoles.length === 0) {
                    // Если роли еще не загружены, загрузим их сначала
                    loadRoles().then(() => loadRewards());
                } else {
                    loadRewards();
                }
            }
        });
    });

    // Загрузка каналов
    async function loadChannels() {
        try {
            const res = await fetch(`/api/guilds/${guildId}/channels`);
            const channels = await res.json();
            
            const textChannels = channels.filter(c => c.type === 0);
            allChannels = textChannels;
            
            channelSelect.innerHTML = '<option value="">Выберите канал</option>' +
                textChannels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
            
            addChannelSelect.innerHTML = '<option value="">Выберите канал для добавления</option>' +
                textChannels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
        } catch (err) {
            console.error('Ошибка загрузки каналов:', err);
        }
    }

    // Загрузка ролей
    async function loadRoles() {
        try {
            const res = await fetch(`/api/guilds/${guildId}/roles`);
            const roles = await res.json();
            
            const filteredRoles = roles.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position);
            allRoles = filteredRoles;
            
            rewardRoleSelect.innerHTML = '<option value="">Выберите роль</option>' +
                filteredRoles.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
            
            addRoleSelect.innerHTML = '<option value="">Выберите роль для добавления</option>' +
                filteredRoles.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
        } catch (err) {
            console.error('Ошибка загрузки ролей:', err);
        }
    }

    // Загрузка настроек
    async function loadSettings() {
        try {
            const res = await fetch('/api/levels/settings');
            const settings = await res.json();
            
            enabledCheckbox.checked = settings.enabled;
            xpMinInput.value = settings.xp_per_message_min;
            xpMaxInput.value = settings.xp_per_message_max;
            cooldownInput.value = settings.xp_cooldown_seconds;
            modeSelect.value = settings.level_up_mode;
            channelSelect.value = settings.level_up_channel_id || '';
            messageInput.value = settings.level_up_message || '';
            
            // Загружаем исключенные роли
            noXpRoles = settings.no_xp_roles || [];
            noXpChannels = settings.no_xp_channels || [];
            
            renderExclusionLists();
        } catch (err) {
            console.error('Ошибка загрузки настроек:', err);
        }
    }

    // Отображение списков исключений
    function renderExclusionLists() {
        // Роли
        if (noXpRoles.length === 0) {
            noXpRolesList.innerHTML = '<div class="text-center text-muted py-2">Нет исключенных ролей</div>';
        } else {
            noXpRolesList.innerHTML = noXpRoles.map(roleId => {
                const role = allRoles.find(r => r.id === roleId);
                const roleName = role ? escapeHtml(role.name) : roleId;
                return `
                    <div class="lvl-exclusion-item">
                        <span class="lvl-exclusion-name">${roleName}</span>
                        <button class="lvl-exclusion-remove" onclick="removeExclusionRole('${roleId}')">
                            <i class="bi bi-trash"></i>
                        </button>
                    </div>
                `;
            }).join('');
        }

        // Каналы
        if (noXpChannels.length === 0) {
            noXpChannelsList.innerHTML = '<div class="text-center text-muted py-2">Нет исключенных каналов</div>';
        } else {
            noXpChannelsList.innerHTML = noXpChannels.map(channelId => {
                const channel = allChannels.find(c => c.id === channelId);
                const channelName = channel ? `#${escapeHtml(channel.name)}` : channelId;
                return `
                    <div class="lvl-exclusion-item">
                        <span class="lvl-exclusion-name">${channelName}</span>
                        <button class="lvl-exclusion-remove" onclick="removeExclusionChannel('${channelId}')">
                            <i class="bi bi-trash"></i>
                        </button>
                    </div>
                `;
            }).join('');
        }
    }

    // Добавление роли в исключения
    el('lvl-add-role-btn').addEventListener('click', () => {
        const roleId = addRoleSelect.value;
        if (!roleId) {
            alert('Выберите роль');
            return;
        }
        
        if (noXpRoles.includes(roleId)) {
            alert('Эта роль уже в списке исключений');
            return;
        }
        
        noXpRoles.push(roleId);
        addRoleSelect.value = '';
        renderExclusionLists();
    });

    // Добавление канала в исключения
    el('lvl-add-channel-btn').addEventListener('click', () => {
        const channelId = addChannelSelect.value;
        if (!channelId) {
            alert('Выберите канал');
            return;
        }
        
        if (noXpChannels.includes(channelId)) {
            alert('Этот канал уже в списке исключений');
            return;
        }
        
        noXpChannels.push(channelId);
        addChannelSelect.value = '';
        renderExclusionLists();
    });

    // Удаление роли из исключений
    window.removeExclusionRole = (roleId) => {
        noXpRoles = noXpRoles.filter(id => id !== roleId);
        renderExclusionLists();
    };

    // Удаление канала из исключений
    window.removeExclusionChannel = (channelId) => {
        noXpChannels = noXpChannels.filter(id => id !== channelId);
        renderExclusionLists();
    };

    // Сохранение настроек
    el('lvl-save-settings').addEventListener('click', async () => {
        try {
            const payload = {
                enabled: enabledCheckbox.checked,
                xp_per_message_min: parseInt(xpMinInput.value, 10),
                xp_per_message_max: parseInt(xpMaxInput.value, 10),
                xp_cooldown_seconds: parseInt(cooldownInput.value, 10),
                level_up_mode: modeSelect.value,
                level_up_channel_id: channelSelect.value || null,
                level_up_message: messageInput.value,
                no_xp_roles: noXpRoles,
                no_xp_channels: noXpChannels
            };

            const res = await fetch('/api/levels/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка сохранения');

            alert('Настройки сохранены!');
        } catch (err) {
            console.error('Ошибка сохранения настроек:', err);
            alert('Ошибка сохранения: ' + err.message);
        }
    });

    // Загрузка наград
    async function loadRewards() {
        try {
            console.log('Loading rewards...');
            const res = await fetch('/api/levels/rewards');
            console.log('Response status:', res.status);

            if (!res.ok) {
                const errorData = await res.json();
                console.error('API Error:', errorData);
                throw new Error(errorData.error || 'Ошибка загрузки наград');
            }

            const rewards = await res.json();
            console.log('Rewards loaded:', rewards);

            if (rewards.length === 0) {
                rewardsList.innerHTML = '<div class="text-center text-muted py-3">Нет наград</div>';
                return;
            }

            rewardsList.innerHTML = rewards.map(r => {
                const role = allRoles.find(role => role.id === r.role_id);
                const roleName = role ? escapeHtml(role.name) : r.role_id;

                return `
                <div class="lvl-reward-item">
                    <div class="lvl-level-badge">${r.level}</div>
                    <div class="lvl-info">
                        <div class="lvl-username">${roleName}</div>
                        <div class="lvl-stats">
                            ${r.remove_previous ? 'Удалять предыдущие' : 'Сохранять предыдущие'}
                        </div>
                    </div>
                    <button class="lvl-remove-reward" onclick="removeReward(${r.level})">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            `}).join('');
        } catch (err) {
            console.error('Ошибка загрузки наград:', err);
            rewardsList.innerHTML = '<div class="text-center text-danger py-3">Ошибка загрузки: ' + err.message + '</div>';
        }
    }

    // Добавление награды
    el('lvl-add-reward').addEventListener('click', async () => {
        const level = parseInt(rewardLevelInput.value, 10);
        const roleId = rewardRoleSelect.value;
        const removePrevious = removePreviousCheckbox.checked;

        console.log('Adding reward:', { level, roleId, removePrevious });

        if (!level || !roleId) {
            alert('Укажите уровень и роль');
            return;
        }

        try {
            const res = await fetch('/api/levels/rewards', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ level, roleId, removePrevious })
            });

            console.log('Response status:', res.status);
            const data = await res.json();
            console.log('Add reward response:', data);

            if (!res.ok) throw new Error(data.error || 'Ошибка добавления награды');

            rewardLevelInput.value = '';
            rewardRoleSelect.value = '';
            removePreviousCheckbox.checked = false;

            // Обновляем список наград
            await loadRewards();
            alert('Награда успешно добавлена!');
        } catch (err) {
            console.error('Ошибка добавления награды:', err);
            alert('Ошибка добавления награды: ' + err.message);
        }
    });

    // Удаление награды
    window.removeReward = async (level) => {
        if (!confirm(`Удалить награду за уровень ${level}?`)) return;
        
        try {
            const res = await fetch(`/api/levels/rewards/${level}`, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка удаления награды');
            
            loadRewards();
        } catch (err) {
            console.error('Ошибка удаления награды:', err);
            alert('Ошибка удаления награды: ' + err.message);
        }
    };

    // Загрузка лидерборда
    async function loadLeaderboard() {
        try {
            const listEl = el('lvl-leaderboard-list');
            listEl.innerHTML = '<div class="text-center text-muted py-4">Загрузка лидерборда...</div>';

            const res = await fetch('/api/levels/leaderboard');
            const leaderboard = await res.json();

            if (leaderboard.length === 0) {
                listEl.innerHTML = '<div class="text-center text-muted py-4">Лидерборд пуст</div>';
                return;
            }

            listEl.innerHTML = leaderboard.map((entry, index) => {
                let rankClass = '';
                if (index === 0) rankClass = 'gold';
                else if (index === 1) rankClass = 'silver';
                else if (index === 2) rankClass = 'bronze';

                // Расчет прогресса до следующего уровня
                const progress = calculateLevelProgress(entry.xp, entry.level);

                return `
                    <div class="lvl-leaderboard-item">
                        <div class="lvl-rank ${rankClass}">${index + 1}</div>
                        <img src="${entry.avatar}" class="lvl-avatar" alt="Avatar">
                        <div class="lvl-info">
                            <div class="lvl-username">${escapeHtml(entry.username)}</div>
                            <div class="lvl-stats">Уровень: ${entry.level} | Сообщений: ${entry.total_messages.toLocaleString()}</div>
                            <div class="lvl-progress-container">
                                <div class="lvl-progress-bar">
                                    <div class="lvl-progress-fill" style="width: ${progress.percentage}%"></div>
                                </div>
                                <div class="lvl-progress-text">
                                    <span>${progress.percentage.toFixed(1)}%</span>
                                    <span>${progress.toNextLevel.toLocaleString()} XP до уровня ${entry.level + 1}</span>
                                </div>
                            </div>
                        </div>
                        <div class="lvl-xp-badge">${entry.xp.toLocaleString()} XP</div>
                    </div>
                `;
            }).join('');
        } catch (err) {
            console.error('Ошибка загрузки лидерборда:', err);
            el('lvl-leaderboard-list').innerHTML = '<div class="text-center text-danger py-4">Ошибка загрузки</div>';
        }
    }

    // Обновление лидерборда
    el('lvl-refresh-leaderboard').addEventListener('click', loadLeaderboard);

    // Загрузка статистики
    async function loadStats() {
        try {
            const res = await fetch('/api/levels/stats');
            const stats = await res.json();

            el('lvl-stat-users').textContent = stats.total_users ? stats.total_users.toLocaleString() : '0';
            el('lvl-stat-avg-level').textContent = stats.average_level ? stats.average_level.toFixed(1) : '0';
            el('lvl-stat-max-level').textContent = stats.max_level || '0';
            el('lvl-stat-total-xp').textContent = stats.total_xp ? (stats.total_xp / 1000000).toFixed(1) + 'M' : '0';
        } catch (err) {
            console.error('Ошибка загрузки статистики:', err);
        }
    }

    // Сбросить XP всех пользователей
    el('lvl-reset-all-xp').addEventListener('click', async () => {
        if (!confirm('Вы уверены, что хотите сбросить XP ВСЕХ пользователей? Это действие необратимо!')) {
            return;
        }

        if (!confirm('ПОДТВЕРЖДЕНИЕ: Все XP, уровни и статистика будут удалены для всех пользователей. Продолжить?')) {
            return;
        }

        try {
            const res = await fetch('/api/levels/reset-all', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            console.log('Response status:', res.status);
            console.log('Response headers:', res.headers);

            const text = await res.text();
            console.log('Response text:', text);

            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                throw new Error('Сервер вернул некорректный ответ. Проверьте консоль.');
            }

            if (!res.ok) throw new Error(data.error || 'Ошибка сброса');

            alert(`XP успешно сброшен для ${data.count} пользователей!`);
            loadStats();
            loadLeaderboard();
        } catch (err) {
            console.error('Ошибка сброса всех XP:', err);
            alert('Ошибка сброса: ' + err.message);
        }
    });

    // Сбросить XP конкретного пользователя
    el('lvl-reset-user-xp').addEventListener('click', async () => {
        const userId = el('lvl-reset-user-id').value.trim();

        if (!userId) {
            alert('Введите Discord ID пользователя');
            return;
        }

        if (!confirm(`Вы уверены, что хотите сбросить XP пользователя ${userId}? Это действие необратимо!`)) {
            return;
        }

        try {
            const res = await fetch(`/api/levels/reset/${userId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            console.log('Response status:', res.status);

            const text = await res.text();
            console.log('Response text:', text);

            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                throw new Error('Сервер вернул некорректный ответ. Проверьте консоль.');
            }

            if (!res.ok) throw new Error(data.error || 'Ошибка сброса');

            alert('XP пользователя успешно сброшен!');
            el('lvl-reset-user-id').value = '';
            loadStats();
            loadLeaderboard();
        } catch (err) {
            console.error('Ошибка сброса XP пользователя:', err);
            alert('Ошибка сброса: ' + err.message);
        }
    });

    // Инициализация
    loadChannels();
    loadRoles().then(() => {
        loadSettings();
        // Загружаем награды только если вкладка наград активна или для теста
        loadRewards();
    });
});

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}