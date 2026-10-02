const { EmbedBuilder } = require('discord.js');
const db = require('./db.js');
const { addImageToEmbed } = require('./spaceImages.js');

module.exports = function(client, sendLog) {
    
    // 📥 УЧАСТНИК ЗАШЕЛ НА СЕРВЕР
    client.on('guildMemberAdd', async (member) => {
        const guild = member.guild;

        // 1. Авто-выдача начальной роли
        const autoRoleId = process.env.AUTO_ROLE_ID;
        if (autoRoleId) {
            const role = guild.roles.cache.get(autoRoleId);
            if (role) {
                await member.roles.add(role).catch(err => {
                    console.error('❌ Ошибка авто-роли. Переместите роль бота ВЫШЕ в настройках Дискорда:', err.message);
                });
            }
        }

        try {
            // Проверяем по базе данных на диске D, заходил ли он когда-то раньше
            const checkUser = await db.query('SELECT first_joined_at FROM user_stats WHERE guild_id = \$1 AND user_id = \$2', [guild.id, member.id]);

            if (checkUser.rows.length === 0) {
                // ---------------- СЦЕНАРИЙ А: ЧЕЛОВЕК ЗАШЕЛ ВПЕРВЫЕ ----------------
                
                // Записываем его первый вход в базу данных
                await db.query('INSERT INTO user_stats (guild_id, user_id) VALUES (\$1, \$2)', [guild.id, member.id]);

                const welcomeNewEmbed = new EmbedBuilder()
                    .setColor('#aa0000') // Бордовый цвет Экзорцистов
                    .setTitle('⚔️ Добро пожаловать в клан Экзорцисты!')
                    .setDescription('Приветствуем тебя, ' + member.user.username + ', в наших рядах! 🌟\n\nТы зашёл на сервер впервые. Мы рады новому бойцу! Обязательно ознакомься с правилами сервера в главном меню, общайся в чатах и заходи в голосовые каналы.\n\nУдачи в битвах! Если возникнут вопросы — ты всегда можешь вызвать главу клана кнопкой в меню.')
                    .setThumbnail(guild.iconURL({ dynamic: true }))
                    .addFields({ name: '📊 Ты наш:', value: '**' + guild.memberCount + '-й** участник сервера!', inline: false })
                    .setTimestamp();
                
                addImageToEmbed(welcomeNewEmbed, 'welcome');

                await member.send({ embeds: [welcomeNewEmbed] }).catch(() => {
                    console.log('💬 Не удалось отправить ЛС новичку ' + member.user.tag + ' (закрыта личка).');
                });

                // Лог модераторам
                await sendLog(guild, '📥 **Новый участник зашёл впервые**\n👤 **Пользователь:** `' + member.user.tag + '`\n🆔 **ID:** `' + member.id + '`', 'member_join');

            } else {
                // ---------------- СЦЕНАРИЙ Б: ЧЕЛОВЕК УЖЕ БЫЛ И ВЕРНУЛСЯ ----------------
                
                const welcomeReturnEmbed = new EmbedBuilder()
                    .setColor('#ff9900') // Оранжевый цвет камбэка
                    .setTitle('🛡️ С возвращением в клан Экзорцисты!')
                    .setDescription('Ого, какие люди, ' + member.user.username + '! Рады снова видеть тебя в нашей обители. ✨\n\nТвоя старая статистика сохранёна в базе данных на диске главы. Заходи в каналы, хватай оружие и возвращайся к общению со своими старыми соратниками!')
                    .setThumbnail(guild.iconURL({ dynamic: true }))
                    .setTimestamp();
                
                addImageToEmbed(welcomeReturnEmbed, 'welcome');

                await member.send({ embeds: [welcomeReturnEmbed] }).catch(() => {
                    console.log('💬 Не удалось отправить ЛС вернувшемуся ' + member.user.tag + ' (закрыта личка).');
                });

                // Лог модераторам
                await sendLog(guild, '🔄 **Участник вернулся на сервер (Повторный вход)**\n👤 **Пользователь:** `' + member.user.tag + '`\n🆔 **ID:** `' + member.id + '`', 'member_join');
            }

        } catch (err) {
            console.error('Ошибка в модуле приветствий:', err.message);
        }
    });

    // 📤 УЧАСТНИК ПОКИНУЛ СЕРВЕР (GOODBYE)
    client.on('guildMemberRemove', async (member) => {
        const guild = member.guild;

        // ---------------- СЦЕНАРИЙ В: ПРОЩАНИЕ В ЛС ----------------
        const goodbyeEmbed = new EmbedBuilder()
            .setColor('#333333') // Темно-серый цвет грусти
            .setTitle('⚔️ Пути клана Экзорцисты расходятся...')
            .setDescription('Жаль, что ты покинул нас, ' + member.user.username + '. 🌌\n\nСпасибо за время, проведённое вместе с нами на сервере **' + guild.name + '**. Если решишь вернуться — наши двери всегда открыты, а твои достижения и варны надёжно хранятся в базе данных на ноутбуке главы.\n\nПрощай и удачи на твоём пути!')
            .setThumbnail(guild.iconURL({ dynamic: true }))
            .setTimestamp();
        
        addImageToEmbed(goodbyeEmbed, 'default');

        // Отправляем в ЛС уходящему (сработает только если он не заблокировал бота или ЛС)
        await member.send({ embeds: [goodbyeEmbed] }).catch(() => {
            console.log('💬 Не удалось отправить ЛС уходящему ' + member.user.tag + ' (уже вышел с сервера, личка закрылась автоматом).');
        });

        // Отправляем тихий лог в скрытый канал модераторов
        await sendLog(guild, `📤 **Участник покинул сервер**\n👤 **Пользователь:** \`${member.user.tag}\`\n🆔 **ID:** \`${member.id}\``, 'member_leave');
    });
};