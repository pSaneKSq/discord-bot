document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('embedBuilderContainer');
    if (!container) return;

    const guildId = container.getAttribute('data-guild-id');
    const reviewSelect = document.getElementById('reviewChannelSelect');
    const logSelect = document.getElementById('logChannelSelect');
    const interviewRoleSelect = document.getElementById('interviewRoleSelect');
    const cooldownSlider = document.getElementById('cooldownSlider');
    const cooldownLabel = document.getElementById('cooldownLabel');

    const savedReviewChannelId = reviewSelect ? reviewSelect.getAttribute('data-saved-value') : '';
    const savedLogChannelId = logSelect ? logSelect.getAttribute('data-saved-value') : '';
    const savedInterviewRoleId = interviewRoleSelect ? interviewRoleSelect.getAttribute('data-saved-value') : '';

    async function loadChannels() {
        if (!reviewSelect && !logSelect) return;
        try {
            const res = await fetch(`/api/guilds/${guildId}/channels`);
            const channels = await res.json();
            if (!Array.isArray(channels)) return;

            if (reviewSelect) {
                reviewSelect.innerHTML = '<option value="">-- Выберите канал --</option>' +
                    channels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
                if (savedReviewChannelId) reviewSelect.value = savedReviewChannelId;
            }
            if (logSelect) {
                logSelect.innerHTML = '<option value="">Не выбрано</option>' +
                    channels.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
                if (savedLogChannelId) logSelect.value = savedLogChannelId;
            }
        } catch (err) {
            console.error('Ошибка загрузки каналов настроек:', err);
            if (reviewSelect) reviewSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
            if (logSelect) logSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        }
    }

    async function loadRolesForInterview() {
        if (!interviewRoleSelect) return;
        try {
            const res = await fetch(`/api/guilds/${guildId}/roles`);
            const roles = await res.json();
            if (!Array.isArray(roles)) return;

            interviewRoleSelect.innerHTML = '<option value="">Не выбрано</option>' +
                roles.map(r => `<option value="${r.id}">@${escapeHtml(r.name)}</option>`).join('');
            if (savedInterviewRoleId) interviewRoleSelect.value = savedInterviewRoleId;
        } catch (err) {
            console.error('Ошибка загрузки ролей для приглашения:', err);
            interviewRoleSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        }
    }

    if (cooldownSlider && cooldownLabel) {
        const updateLabel = () => {
            const v = parseInt(cooldownSlider.value, 10);
            cooldownLabel.textContent = v === 0 ? 'Без ожидания' : `${v} мин.`;
        };
        cooldownSlider.addEventListener('input', updateLabel);
        updateLabel();

        document.querySelectorAll('.cooldown-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                cooldownSlider.value = btn.getAttribute('data-value');
                updateLabel();
            });
        });
    }

    loadChannels();
    loadRolesForInterview();

    // Собирает текущие настройки — вызывается при сохранении (см. embedBuilder.js)
    window.getSettingsData = function () {
        return {
            reviewChannelId: reviewSelect ? reviewSelect.value : '',
            logChannelId: logSelect ? logSelect.value : '',
            interviewRoleId: interviewRoleSelect ? interviewRoleSelect.value : '',
            cooldownMinutes: cooldownSlider ? parseInt(cooldownSlider.value, 10) : 5
        };
    };
});