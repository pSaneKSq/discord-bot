const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('./db.js');
const { addImageToEmbed } = require('./spaceImages.js');

module.exports = function(client) {
    
    // СЛУШАЕМ СЛЭШ-КОМАНДУ /MENU
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand() || interaction.commandName !== 'menu') return;

        try {
            const embed = new EmbedBuilder()
                .setColor('#aa0000') // Темно-красный цвет Экзорцистов
                .setTitle('⚔️ Главная панель клана Экзорцисты')
                .setDescription('Приветствуем тебя в нашей обители нарушителей порядка и борцов со злом! Используй интерактивные кнопки ниже, чтобы управлять своими данными или вызвать главу клана.')
                .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
                .setFooter({ text: 'Скрытое меню клана Экзорцисты', iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp();
            
            addImageToEmbed(embed, 'main');

            const btnServerStats = new ButtonBuilder()
                .setCustomId('menu_server_stats')
                .setLabel('📊 Статистика сервера')
                .setStyle(ButtonStyle.Secondary);

            const btnMyStats = new ButtonBuilder()
                .setCustomId('menu_my_stats')
                .setLabel('👤 Моя активность')
                .setStyle(ButtonStyle.Primary);

            const btnCallLeader = new ButtonBuilder()
                .setCustomId('menu_call_saneks')
                .setLabel('🚨 Вызвать SaneKS`a')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder().addComponents(btnServerStats, btnMyStats, btnCallLeader);

            await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });

        } catch (err) {
            console.error('Ошибка вызова меню:', err.message);
        }
    });

    // ОБРАБОТЧИК НАЖАТИЙ НА КНОПКИ МЕНЮ
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton() || !interaction.customId.startsWith('menu_')) return;

        const { customId, guild, user } = interaction;

        try {
            // --- КНОПКА 1: СТАТИСТИКА СЕРВЕРА ---
            if (customId === 'menu_server_stats') {
                const totalMembers = guild.memberCount;
                
                // Считаем онлайн участников (Сработает сразу после включения Presence Intent на сайте)
                const onlineCount = guild.members.cache.filter(m => m.presence?.status && m.presence.status !== 'offline').size;
                
                const statsEmbed = new EmbedBuilder()
                    .setColor('#660099')
                    .setTitle('📊 Статистика сервера «Воскресенье»')
                    .addFields(
                        { name: '👥 Всего в клане:', value: `**${totalMembers}** участников`, inline: true },
                        { name: '🟢 Сейчас онлайн:', value: `**${onlineCount}** участников`, inline: true }
                    )
                    .setTimestamp();
                
                addImageToEmbed(statsEmbed, 'stats');

                return interaction.reply({ embeds: [statsEmbed], flags: MessageFlags.Ephemeral });
            }

            // --- КНОПКА 2: СТАТИСТИКА АКТИВНОСТИ ПОЛЬЗОВАТЕЛЯ (С ИСПРАВЛЕННЫМ ТЕКСТОМ) ---
            if (customId === 'menu_my_stats') {
                const res = await db.query('SELECT messages_count, voice_seconds FROM user_stats WHERE guild_id = \$1 AND user_id = \$2', [guild.id, user.id]);
                
                let msgCount = 0;
                let voiceSec = 0;

                if (res.rows.length > 0) {
                    msgCount = res.rows.messages_count || 0;
                    voiceSec = res.rows.voice_seconds || 0;
                }

                const hours = Math.floor(voiceSec / 3600);
                const minutes = Math.floor((voiceSec % 3600) / 60);
                const timeInVoice = `${hours} ч. ${minutes} мин.`;

                const member = await guild.members.fetch(user.id);
                const joinedDays = Math.floor((Date.now() - member.joinedTimestamp) / (1000 * 60 * 60 * 24));

                const userEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('👤 Ваша статистика в клане Экзорцисты')
                    .setDescription('ℹ️ *Активность в чатах и войсах учитывается с момента запуска этого бота.*') // Добавили примечание нарушителю
                    .addFields(
                        { name: '💬 Отправлено сообщений:', value: `**${msgCount}** шт.`, inline: false },
                        { name: '🎙️ Проведено в войсах:', value: `**${timeInVoice}**`, inline: false },
                        { name: '📅 Времени в клане:', value: `Вы с нами уже **${joinedDays}** дней!`, inline: false }
                    )
                    .setTimestamp();
                
                addImageToEmbed(userEmbed, 'activity');

                return interaction.reply({ embeds: [userEmbed], flags: MessageFlags.Ephemeral });
            }

            // --- КНОПКА 3: ВЫЗВАТЬ САНЕКСА ---
            if (customId === 'menu_call_saneks') {
                await interaction.reply({ content: '🚨 **Вызов отправлен!** SaneKS уже в пути, ожидайте ответа главы клана.', flags: MessageFlags.Ephemeral });

                const serverOwner = await guild.fetchOwner();
                if (serverOwner) {
                    try {
                        await serverOwner.send(`🚨 **ВНИМАНИЕ, SaneKS!** На сервере **${guild.name}** тебя срочно вызывает участник **${user.tag}** (<@${user.id}>) через главное меню бота!`);
                    } catch (dmErr) {
                        console.log('❌ Не удалось отправить ЛС Санексу, возможно закрыто личко.');
                    }
                }
            }

        } catch (err) {
            console.error('Ошибка клика в меню:', err.message);
        }
    });
};
