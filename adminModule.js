const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const warnService = require('./warnService.js');

module.exports = function(client, sendLog) {

    // 1. СЛУШАЕМ СЛЭШ-КОМАНДУ /ADMIN
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand() || interaction.commandName !== 'admin') return;

        if (!interaction.member.permissions.has('KickMembers')) {
            return interaction.reply({ content: '❌ У вас нет прав на использование админ-панели.', flags: MessageFlags.Ephemeral });
        }

        try {
            // Запоминаем выбранного пользователя, если модератор его указал
            const targetMember = interaction.options.getMember('пользователь');
            const targetId = targetMember ? targetMember.id : 'no_user';

            const embed = new EmbedBuilder()
                .setColor('#330000')
                .setTitle('🛡️ Админ-панель клана Экзорцисты')
                .setDescription('Добро пожаловать в командный центр, ' + interaction.user.username + '.\n\n' +
                                '👤 Выбранный нарушитель: ' + (targetMember ? `${targetMember}` : '**Не выбран**') + '\n\n' +
                                'Используйте кнопки ниже для контроля нарушений или экстренного сбора состава клана. Эта панель полностью приватна.')
                .setFooter({ text: 'Командный центр Экзорцистов', iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp();

            // ID пользователя закладываем прямо в ID кнопки
            const btnWarns = new ButtonBuilder()
                .setCustomId('admin_open_warns_' + targetId)
                .setLabel('⚠️ Управление варнами')
                .setStyle(ButtonStyle.Primary);

            const btnCallSostav = new ButtonBuilder()
                .setCustomId('admin_call_sostav')
                .setLabel('⚔️ Созвать состав!')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder().addComponents(btnWarns, btnCallSostav);

            await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });

        } catch (err) {
            console.error('Ошибка вызова админки:', err.message);
        }
    });

    // 2. ОБРАБОТЧИК НАЖАТИЙ НА КНОПКИ АДМИНКИ
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton() || !interaction.customId.startsWith('admin_')) return;

        const { customId, guild, user } = interaction;

        try {
            // --- КНОПКА А: УПРАВЛЕНИЕ ВАРНАМИ ---
            if (customId.startsWith('admin_open_warns_')) {
                const targetId = customId.split('_')[3];

                if (targetId === 'no_user') {
                    return interaction.reply({
                        content: '❌ Ошибка: Вы не выбрали пользователя при вызове команды! Пишите вот так: `/admin пользователь: @Имя`',
                        flags: MessageFlags.Ephemeral
                    });
                }

                const targetMember = await guild.members.fetch(targetId).catch(() => null);
                if (!targetMember) {
                    return interaction.reply({ content: '❌ Пользователь не найден на сервере.', flags: MessageFlags.Ephemeral });
                }

                const currentWarns = await warnService.getActiveCount(guild.id, targetId);

                const warnEmbed = warnService.buildPanelEmbed({
                    description: 'Управление нарушениями для пользователя ' + targetMember.user.tag,
                    active: currentWarns,
                    moderator: interaction.user
                });
                const rowMenu = warnService.buildWarnMenu(targetId, interaction.user.id, guild.id);

                // Админ-панель превращается в меню варнов нарушителя
                return interaction.update({ embeds: [warnEmbed], components: [rowMenu] });
            }

            // --- КНОПКА Б: ЭКСТРЕННЫЙ СОЗЫВ СОСТАВА (В ЛС) ---
            if (customId === 'admin_call_sostav') {
                const sostavRoleId = process.env.SOSTAV_ROLE_ID;
                if (!sostavRoleId) {
                    return interaction.reply({ content: '❌ Ошибка: В файле `.env` не указана переменная `SOSTAV_ROLE_ID`!', flags: MessageFlags.Ephemeral });
                }

                await interaction.reply({ content: '🚨 **Запуск экстренного созыва...** Бот рассылает сообщения составу клана.', flags: MessageFlags.Ephemeral });

                const sostavRole = guild.roles.cache.get(sostavRoleId);
                if (!sostavRole) {
                    return interaction.followUp({ content: '❌ Ошибка: Роль с указанным ID не найдена на сервере.', flags: MessageFlags.Ephemeral });
                }

                await guild.members.fetch();
                const membersWithRole = sostavRole.members;

                let successCount = 0;
                let failCount = 0;

                const callEmbed = new EmbedBuilder()
                    .setColor('#aa0000')
                    .setTitle('🚨 СРОЧНЫЙ СБОР СОСТАВА КЛАНА ЭКЗОРЦИСТЫ 🚨')
                    .setDescription('Внимание, боец! Объявлена экстренная мобилизация состава.\n\n⚔️ **Глава клана или старший модератор собирает всех прямо сейчас.**\n📌 **Приказ:** Срочно перейти в голосовой канал **Конференц-зал**!\n\nЯвка обязательна, не заставляйте руководство ждать.')
                    .setThumbnail(guild.iconURL({ dynamic: true }))
                    .setFooter({ text: 'Вызов инициировал: ' + user.tag })
                    .setTimestamp();

                for (const [id, member] of membersWithRole) {
                    if (member.user.bot) continue;
                    try {
                        await member.send({ embeds: [callEmbed] });
                        successCount++;
                    } catch (err) {
                        failCount++;
                    }
                }

                await interaction.followUp({
                    content: '✅ **Созыв состава завершён!**\n📬 Успешно доставлено: **' + successCount + '** бойцам.\n🔒 Закрыто личных сообщений: **' + failCount + '**.',
                    flags: MessageFlags.Ephemeral
                });

                await sendLog(guild, '🚨 **ОБЪЯВЛЕН СБОР СОСТАВА**\n🛠️ **Инициатор:** `' + user.tag + '`\n📊 **Статус рассылки:** Отправлено: `' + successCount + '`, Ошибки ЛС: `' + failCount + '`', 'sostav_call');
            }

        } catch (err) {
            console.error('Ошибка в админ-модуле:', err.message);
        }
    });
};