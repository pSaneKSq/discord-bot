const { MessageFlags } = require('discord.js');
const db = require('./db.js');
const warnService = require('./warnService.js');

const EPHEMERAL = MessageFlags.Ephemeral;

// initWarnHandler вызывается ТОЛЬКО из index.js, один раз на весь бот
// (иначе клик по меню варнов срабатывает дважды).
module.exports = function(client, sendLog) {
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('warn_menu_')) return;

        const [, , targetId, moderatorId, guildId] = interaction.customId.split('_');

        if (interaction.user.id !== moderatorId) {
            return interaction.reply({ content: '❌ Эту панель вызвали не вы!', flags: EPHEMERAL });
        }

        const guild = interaction.guild || client.guilds.cache.get(guildId);
        if (!guild) return interaction.reply({ content: '❌ Не удалось определить сервер.', flags: EPHEMERAL });

        const targetMember = await guild.members.fetch(targetId).catch(() => null);
        if (!targetMember) return interaction.reply({ content: '❌ Пользователь покинул сервер.', flags: EPHEMERAL });

        const choice = interaction.values[0];
        const tag = targetMember.user.tag;

        try {
            // ВЫДАТЬ 1 ВАРН
            if (choice === 'give_1') {
                const { previous, current } = await warnService.addWarnings(guild.id, targetId, moderatorId, 'Панель', 1);

                await interaction.reply({
                    content: `⚠️ Вы выдали 1 предупреждение для \`${tag}\`. Активных теперь: ${warnService.formatStatus(current)}`,
                    flags: EPHEMERAL
                });

                await sendLog(
                    guild,
                    `⚠️ **ВЫДАНО ПРЕДУПРЕЖДЕНИЕ**\n👤 **Нарушитель:** \`${tag}\`\n🛠️ **Модератор:** \`${interaction.user.tag}\`\n📊 **Активных варнов:** ${current}`,
                    'warn'
                );

                const punishment = await warnService.applyLadder(guild, targetMember, previous, current, sendLog);
                if (punishment && punishment.ok) {
                    await interaction.channel?.send(
                        `🤐 Участник \`${tag}\` получил автонаказание за ${current} активных предупреждений: **${warnService.describeStep(punishment.step)}**.`
                    ).catch(() => {});
                } else if (punishment && !punishment.ok) {
                    await interaction.followUp({
                        content: `⚠️ Автонаказание не применено: ${punishment.error}`,
                        flags: EPHEMERAL
                    }).catch(() => {});
                }
            }

            // ВЫДАТЬ СРАЗУ 4 ВАРНА (максимальное наказание: мут на 7 дней)
            else if (choice === 'give_4') {
                const { current } = await warnService.addWarnings(guild.id, targetId, moderatorId, 'Массовый варн', 4);

                let muteNote = '';
                try {
                    await targetMember.timeout(7 * 24 * 60 * 60 * 1000, 'Мгновенный мут');
                } catch (err) {
                    muteNote = `\n⚠️ Мут не применён: ${err.message}`;
                }

                await interaction.reply({
                    content: `🚨 Вы выдали максимальное наказание для \`${tag}\`. Юзер в муте на 7 дней!${muteNote}`,
                    flags: EPHEMERAL
                });

                await sendLog(
                    guild,
                    `🚨 **МГНОВЕННЫЙ АВТО-МУТ ЧЕРЕЗ МЕНЮ** 🚨\n👤 **Нарушитель:** \`${tag}\`\n🛠️ **Выдал:** \`${interaction.user.tag}\`\n📊 **Активных варнов:** ${current}`,
                    'warn'
                );
            }

            // ПОСМОТРЕТЬ ИСТОРИЮ
            else if (choice === 'view_list') {
                const res = await db.query(
                    `SELECT id, reason, moderator_id, created_at, expires_at FROM warnings
                     WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 15`,
                    [guild.id, targetId]
                );

                if (res.rows.length === 0) {
                    return interaction.reply({ content: `✅ У пользователя \`${tag}\` нет предупреждений.`, flags: EPHEMERAL });
                }

                let listText = `📜 **История предупреждений для пользователя ${tag}** (последние 15):\n\n`;
                res.rows.forEach((row) => {
                    listText += `🆔 **[ID: ${row.id}]** — Модератор: <@${row.moderator_id}>\n` +
                        `📝 *Причина:* ${row.reason} — 📅 *${new Date(row.created_at).toLocaleDateString('ru-RU')}* — ${warnService.formatExpiry(row.expires_at)}\n\n`;
                });

                if (listText.length > 1900) listText = listText.slice(0, 1890) + '…';
                return interaction.reply({ content: listText, flags: EPHEMERAL });
            }

            // СНЯТЬ 1 ВАРН (последний активный)
            else if (choice === 'remove_1') {
                const findLatest = await db.query(
                    `SELECT id FROM warnings
                     WHERE guild_id = $1 AND user_id = $2 AND ${warnService.ACTIVE_CONDITION}
                     ORDER BY created_at DESC LIMIT 1`,
                    [guild.id, targetId]
                );

                if (findLatest.rows.length === 0) {
                    return interaction.reply({ content: `❌ У пользователя \`${tag}\` нет активных варнов.`, flags: EPHEMERAL });
                }

                await db.query('DELETE FROM warnings WHERE id = $1 AND guild_id = $2', [findLatest.rows[0].id, guild.id]);
                const remaining = await warnService.getActiveCount(guild.id, targetId);

                let replyMessage = `🔄 С пользователя \`${tag}\` снято последнее предупреждение. Активных осталось: ${warnService.formatStatus(remaining)}`;

                // Снимаем мут, если варнов стало меньше, чем нужно для самой первой ступени с таймаутом
                const lowestTimeout = warnService.getLowestTimeoutCount();
                if (lowestTimeout !== null && remaining < lowestTimeout && targetMember.isCommunicationDisabled()) {
                    try {
                        await targetMember.timeout(null, 'Мут снят');
                        replyMessage += '\n🔊 Пользователь также автоматически **размучен**!';
                    } catch (err) {
                        replyMessage += `\n⚠️ Не удалось снять мут: ${err.message}`;
                    }
                }

                await interaction.reply({ content: replyMessage, flags: EPHEMERAL });
                await sendLog(guild, `🔄 **СНЯТО ПРЕДУПРЕЖДЕНИЕ**\n👤 **Пользователь:** \`${tag}\`\n🛠️ **Модератор:** \`${interaction.user.tag}\``, 'warn');
            }

            // ОЧИСТИТЬ ВСЕ ВАРНЫ
            else if (choice === 'clear_all') {
                await db.query('DELETE FROM warnings WHERE guild_id = $1 AND user_id = $2', [guild.id, targetId]);
                let replyMessage = `✅ Вы полностью очистили историю предупреждений для \`${tag}\`.`;

                if (targetMember.isCommunicationDisabled()) {
                    try {
                        await targetMember.timeout(null, 'Очистка варнов');
                        replyMessage += '\n🔊 Пользователь автоматически **размучен**!';
                    } catch (err) {
                        replyMessage += `\n⚠️ Не удалось снять мут: ${err.message}`;
                    }
                }

                await interaction.reply({ content: replyMessage, flags: EPHEMERAL });
                await sendLog(guild, `✅ **ИСТОРИЯ ВАРНОВ ОЧИЩЕНА**\n👤 **Пользователь:** \`${tag}\`\n🛠️ **Модератор:** \`${interaction.user.tag}\``, 'warn');
            }

            // Обновляем панель (мягко — если сообщение уже устарело, просто пропускаем)
            const updatedWarns = await warnService.getActiveCount(guild.id, targetId);
            const updatedEmbed = warnService.buildPanelEmbed({
                description: `Управление нарушениями для пользователя ${tag}`,
                active: updatedWarns,
                moderator: interaction.user
            });

            try {
                await interaction.message.edit({ embeds: [updatedEmbed] });
            } catch (editErr) {
                console.log('ℹ️ Не удалось обновить панель варнов (сообщение устарело или удалено) — это не влияет на сам варн.');
            }

        } catch (err) {
            console.error('Ошибка в обработчике варнов:', err);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Произошла ошибка. Подробности — в консоли бота.', flags: EPHEMERAL }).catch(() => {});
            }
        }
    });
};