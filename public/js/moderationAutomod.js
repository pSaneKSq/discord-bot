document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('automodPage');
    if (!page) return;

    const guildId = page.dataset.guildId;

    const enabledSwitch = document.getElementById('automodEnabledSwitch');

    const bannedWordsSwitch = document.getElementById('bannedWordsEnabledSwitch');
    const bannedWordsTextarea = document.getElementById('bannedWordsTextarea');

    const spamSwitch = document.getElementById('spamEnabledSwitch');
    const spamMaxMessages = document.getElementById('spamMaxMessagesInput');
    const spamPerSeconds = document.getElementById('spamPerSecondsInput');

    const capsSwitch = document.getElementById('capsEnabledSwitch');
    const capsMinLength = document.getElementById('capsMinLengthInput');
    const capsMaxPercent = document.getElementById('capsMaxPercentInput');

    const invitesSwitch = document.getElementById('invitesEnabledSwitch');

    const mentionSwitch = document.getElementById('mentionSpamEnabledSwitch');
    const mentionMax = document.getElementById('mentionMaxInput');

    // «Защита от тупых людей»
    const pedantrySwitch = document.getElementById('pedantryEnabledSwitch');
    const pedantryMuteValue = document.getElementById('pedantryMuteValueInput');
    const pedantryMuteUnit = document.getElementById('pedantryMuteUnitSelect');
    const pedantryDeleteSwitch = document.getElementById('pedantryDeleteSwitch');
    const pedantrySendDmSwitch = document.getElementById('pedantrySendDmSwitch');
    const pedantryDmTextarea = document.getElementById('pedantryDmTextarea');
    const pedantryPhrasesTextarea = document.getElementById('pedantryPhrasesTextarea');
    const pedantryStrictSwitch = document.getElementById('pedantryStrictSwitch');

    const PEDANTRY_MAX_MINUTES = 28 * 24 * 60; // предел таймаута в Discord

    const exemptRolesList = document.getElementById('exemptRolesList');
    const saveBtn = document.getElementById('automodSaveBtn');
    const statusEl = document.getElementById('automodSaveStatus');

    // Показываем срок мута в самых удобных единицах (дни / часы / минуты)
    function setMuteDuration(totalMinutes) {
        const minutes = parseInt(totalMinutes, 10) || 60;
        if (minutes % 1440 === 0) {
            pedantryMuteValue.value = minutes / 1440;
            pedantryMuteUnit.value = '1440';
        } else if (minutes % 60 === 0) {
            pedantryMuteValue.value = minutes / 60;
            pedantryMuteUnit.value = '60';
        } else {
            pedantryMuteValue.value = minutes;
            pedantryMuteUnit.value = '1';
        }
    }

    function getMuteMinutes() {
        const value = parseInt(pedantryMuteValue.value, 10);
        const unit = parseInt(pedantryMuteUnit.value, 10) || 1;
        if (!Number.isFinite(value) || value < 1) return 60;
        return Math.min(PEDANTRY_MAX_MINUTES, value * unit);
    }

    async function loadRoles(selectedIds) {
        try {
            const res = await fetch(`/api/guilds/${guildId}/roles`);
            const roles = await res.json();
            exemptRolesList.innerHTML = roles.length ? roles.map(role => `
                <label class="d-flex align-items-center gap-2 small mb-1">
                    <input type="checkbox" class="form-check-input exempt-role-checkbox" value="${role.id}" ${selectedIds.includes(role.id) ? 'checked' : ''}>
                    <span style="color:${role.color && role.color !== '#000000' ? role.color : '#d1d5db'}">${escapeHtml(role.name)}</span>
                </label>
            `).join('') : '<span class="text-muted small">Роли не найдены</span>';
        } catch (err) {
            exemptRolesList.innerHTML = '<span class="text-danger small">Не удалось загрузить роли</span>';
            console.error('Ошибка загрузки ролей:', err);
        }
    }

    async function loadSettings() {
        try {
            const res = await fetch('/api/automod/settings');
            const settings = await res.json();

            enabledSwitch.checked = !!settings.enabled;

            bannedWordsSwitch.checked = !!settings.bannedWords.enabled;
            bannedWordsTextarea.value = (settings.bannedWords.words || []).join('\n');

            spamSwitch.checked = !!settings.spam.enabled;
            spamMaxMessages.value = settings.spam.maxMessages;
            spamPerSeconds.value = settings.spam.perSeconds;

            capsSwitch.checked = !!settings.caps.enabled;
            capsMinLength.value = settings.caps.minLength;
            capsMaxPercent.value = settings.caps.maxPercent;

            invitesSwitch.checked = !!settings.invites.enabled;

            mentionSwitch.checked = !!settings.mentionSpam.enabled;
            mentionMax.value = settings.mentionSpam.maxMentions;

            const ped = settings.pedantry || {};
            pedantrySwitch.checked = !!ped.enabled;
            setMuteDuration(ped.muteMinutes);
            pedantryDeleteSwitch.checked = !!ped.deleteMessage;
            pedantrySendDmSwitch.checked = ped.sendDm !== false;
            pedantryDmTextarea.value = ped.dmText || '';
            pedantryPhrasesTextarea.value = (ped.triggerPhrases || []).join('\n');
            pedantryStrictSwitch.checked = !!ped.strictAsterisk;

            await loadRoles(settings.exemptRoleIds || []);
        } catch (err) {
            console.error('Ошибка загрузки настроек автомодерации:', err);
        }
    }

    saveBtn.addEventListener('click', async () => {
        const exemptRoleIds = Array.from(document.querySelectorAll('.exempt-role-checkbox:checked')).map(cb => cb.value);

        const payload = {
            enabled: enabledSwitch.checked,
            exemptRoleIds,
            bannedWords: {
                enabled: bannedWordsSwitch.checked,
                words: bannedWordsTextarea.value.split('\n').map(w => w.trim()).filter(Boolean)
            },
            spam: {
                enabled: spamSwitch.checked,
                maxMessages: parseInt(spamMaxMessages.value, 10) || 5,
                perSeconds: parseInt(spamPerSeconds.value, 10) || 5
            },
            caps: {
                enabled: capsSwitch.checked,
                minLength: parseInt(capsMinLength.value, 10) || 10,
                maxPercent: parseInt(capsMaxPercent.value, 10) || 70
            },
            invites: {
                enabled: invitesSwitch.checked
            },
            mentionSpam: {
                enabled: mentionSwitch.checked,
                maxMentions: parseInt(mentionMax.value, 10) || 5
            },
            pedantry: {
                enabled: pedantrySwitch.checked,
                muteMinutes: getMuteMinutes(),
                deleteMessage: pedantryDeleteSwitch.checked,
                sendDm: pedantrySendDmSwitch.checked,
                dmText: pedantryDmTextarea.value,
                triggerPhrases: pedantryPhrasesTextarea.value.split('\n').map(p => p.trim()).filter(Boolean),
                strictAsterisk: pedantryStrictSwitch.checked
            }
        };

        try {
            statusEl.textContent = 'Сохранение...';
            const res = await fetch('/api/automod/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error('Ошибка сохранения');
            const data = await res.json();

            // Подтягиваем то, что реально сохранилось (сервер мог поправить значения, например срок мута)
            if (data.settings && data.settings.pedantry) {
                setMuteDuration(data.settings.pedantry.muteMinutes);
                pedantryDmTextarea.value = data.settings.pedantry.dmText || '';
                pedantryPhrasesTextarea.value = (data.settings.pedantry.triggerPhrases || []).join('\n');
            }

            statusEl.textContent = '✅ Сохранено';
            setTimeout(() => { statusEl.textContent = ''; }, 2000);
        } catch (err) {
            statusEl.textContent = '❌ Не удалось сохранить';
            console.error('Ошибка сохранения настроек автомодерации:', err);
        }
    });

    loadSettings();
});