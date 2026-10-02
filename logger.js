const { EmbedBuilder } = require('discord.js');
const db = require('./db.js');
const moderationStore = require('./moderationStore.js');

const EVENT_META = {
    warn:           { color: '#ff9900', label: '⚠️ Предупреждения' },
    member_join:    { color: '#22c55e', label: '📥 Вход участника' },
    member_leave:   { color: '#6b7280', label: '📤 Выход участника' },
    sostav_call:    { color: '#aa0000', label: '🚨 Созыв состава' },
    form_decision:  { color: '#3b82f6', label: '📝 Решение по заявке' },
    automod:        { color: '#f97316', label: '🤖 Автомодерация' },
    message_edit:   { color: '#38bdf8', label: '✏️ Правка сообщения' },
    message_delete: { color: '#ef4444', label: '🗑️ Удаление сообщения' },
    weekly_report:  { color: '#8b5cf6', label: '📊 Еженедельный отчёт' },
    poll:           { color: '#06b6d4', label: '🗳️ Опросы' },
    other:          { color: '#8b5cf6', label: 'ℹ️ Событие' }
};

// Единая функция логирования: пишет в БД (для вкладки "Журнал" на сайте) всегда,
// и дублирует в Discord-канал, если он настроен на вкладке "Настройки логов"
// и этот тип события там включён.
async function sendLog(guild, message, eventType = 'other') {
    const meta = EVENT_META[eventType] || EVENT_META.other;

    try {
        await db.query(
            'INSERT INTO mod_logs (guild_id, event_type, message) VALUES ($1, $2, $3)',
            [guild.id, eventType, message]
        );
    } catch (err) {
        console.error('❌ Не удалось записать лог в БД:', err.message);
    }

    try {
        const settings = moderationStore.getSettings(guild.id);
        const enabled = settings.events[eventType] !== false;
        if (!settings.logChannelId || !enabled) return;

        const channel = await guild.channels.fetch(settings.logChannelId).catch(() => null);
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setColor(meta.color)
            .setTitle(meta.label)
            .setDescription(String(message).slice(0, 4000))
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (err) {
        console.error('❌ Не удалось отправить лог в Discord-канал:', err.message);
    }
}

module.exports = { sendLog, EVENT_META };