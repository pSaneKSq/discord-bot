const { MessageFlags } = require('discord.js');
const warnService = require('./warnService.js');

// initWarnHandler здесь не вызывается — он подключается один раз из index.js.
module.exports = function(client, sendLog) {

    // Слушаем запуск слэш-команды /warn
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand() || interaction.commandName !== 'warn') return;

        if (!interaction.member.permissions.has('KickMembers')) {
            return interaction.reply({ content: '❌ У вас нет прав на управление предупреждениями.', flags: MessageFlags.Ephemeral });
        }

        const targetMember = interaction.options.getMember('пользователь');
        if (!targetMember) {
            return interaction.reply({ content: '❌ Пользователь не найден на сервере.', flags: MessageFlags.Ephemeral });
        }
        if (targetMember.user.bot) {
            return interaction.reply({ content: '❌ Вы не можете выдавать варны ботам.', flags: MessageFlags.Ephemeral });
        }

        try {
            const active = await warnService.getActiveCount(interaction.guild.id, targetMember.id);

            const embed = warnService.buildPanelEmbed({
                description: `Управление нарушениями для пользователя ${targetMember}`,
                active,
                moderator: interaction.user
            });
            const row = warnService.buildWarnMenu(targetMember.id, interaction.user.id, interaction.guild.id);

            await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });

        } catch (err) {
            console.error('Ошибка вызова панели:', err);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Произошла ошибка при создании панели.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
    });
};