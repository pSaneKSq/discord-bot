const { EmbedBuilder } = require('discord.js');
const store = require('./levelsStore.js');
const { addImageToEmbed } = require('./spaceImages.js');

const xpCooldowns = new Map(); // ключ: `${guildId}:${userId}` -> timestamp

// Генерация случайного XP в заданном диапазоне
function getRandomXp(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Замена переменных в сообщениях
function replaceVariables(text, variables) {
    let result = text;
    for (const [key, value] of Object.entries(variables)) {
        result = result.replace(new RegExp(`{${key}}`, 'g'), value);
    }
    return result;
}

// Обработка начисления XP за сообщение
async function processMessageXp(client, message, sendLog) {
    try {
        const guildId = message.guild.id;
        const settings = await store.getLevelSettings(guildId);
        if (!settings || !settings.enabled) return;

        // Проверяем исключения
        const userId = message.author.id;
        const channelId = message.channel.id;

        // Проверка ролей
        if (settings.no_xp_roles && settings.no_xp_roles.length > 0) {
            const member = message.member;
            if (member) {
                const hasExemptRole = member.roles.cache.some(role =>
                    settings.no_xp_roles.includes(role.id)
                );
                if (hasExemptRole) return;
            }
        }

        // Проверка каналов
        if (settings.no_xp_channels && settings.no_xp_channels.length > 0) {
            if (settings.no_xp_channels.includes(channelId)) return;
        }

        // Проверка кулдауна
        const cooldownMs = settings.xp_cooldown_seconds * 1000;
        const cooldownKey = `${guildId}:${userId}`;
        const lastXpTime = xpCooldowns.get(cooldownKey) || 0;
        const now = Date.now();

        if (now - lastXpTime < cooldownMs) return;

        // Начисляем XP
        const xpAmount = getRandomXp(settings.xp_per_message_min, settings.xp_per_message_max);
        console.log(`Adding ${xpAmount} XP to user ${userId} for message in guild ${guildId}`);

        const result = await store.addXp(guildId, userId, xpAmount);

        // Обновляем кулдаун
        xpCooldowns.set(cooldownKey, now);

        // Если был левел-ап
        if (result.levelUp) {
            console.log(`Level up for user ${userId}: ${result.previousLevel} -> ${result.newLevel}`);
            await handleLevelUp(client, message.member, result, settings, sendLog);
        }
    } catch (err) {
        console.error('Ошибка обработки XP:', err.message);
    }
}

// Обработка левел-апа
async function handleLevelUp(client, member, levelResult, settings, sendLog) {
    try {
        const { user, newLevel, previousLevel } = levelResult;
        
        // Получаем награду за новый уровень
        const reward = await store.getLevelReward(member.guild.id, newLevel);
        
        // Выдаем роль если есть награда
        if (reward) {
            const role = member.guild.roles.cache.get(reward.role_id);
            if (role) {
                try {
                    // Если нужно удалить предыдущие награды
                    if (reward.remove_previous) {
                        const allRewards = await store.getLevelRewards(member.guild.id);
                        for (const r of allRewards) {
                            if (r.level < newLevel) {
                                const prevRole = member.guild.roles.cache.get(r.role_id);
                                if (prevRole && member.roles.cache.has(prevRole.id)) {
                                    await member.roles.remove(prevRole.id);
                                }
                            }
                        }
                    }
                    
                    await member.roles.add(role.id);
                } catch (err) {
                    console.error(`Ошибка выдачи роли за уровень ${newLevel}:`, err.message);
                }
            }
        }

        // Отправляем уведомление о левел-апе
        await sendLevelUpMessage(client, member, newLevel, settings);
        
        // Логируем
        await sendLog(member.guild, 
            `🎊 **Левел-ап**: <@${member.id}> достиг уровня **${newLevel}** (был ${previousLevel})`, 
            'other'
        );
    } catch (err) {
        console.error('Ошибка обработки левел-апа:', err.message);
    }
}

// Отправка уведомления о левел-апе
async function sendLevelUpMessage(client, member, newLevel, settings) {
    try {
        const guild = member.guild;
        if (!guild) return;

        const variables = {
            user: `<@${member.id}>`,
            username: member.user.username,
            level: newLevel,
            server: guild.name
        };

        const message = replaceVariables(settings.level_up_message, variables);

        switch (settings.level_up_mode) {
            case 'current':
                await member.channel.send(message).catch(() => {});
                break;
            case 'dm':
                await member.send(message).catch(() => {});
                break;
            case 'channel':
                if (settings.level_up_channel_id) {
                    const channel = await guild.channels.fetch(settings.level_up_channel_id);
                    if (channel && channel.isTextBased()) {
                        await channel.send(message);
                    }
                }
                break;
            case 'disabled':
                // Не отправляем уведомление
                break;
        }
    } catch (err) {
        console.error('Ошибка отправки уведомления о левел-апе:', err.message);
    }
}

// Генерация ранковой карточки
async function generateRankCard(guild, member, userLevel) {
    try {
        const progress = store.calculateLevelProgress(userLevel.xp, userLevel.level);
        
        const card = new EmbedBuilder()
            .setTitle(`🎮 ${member.user.username}`)
            .setDescription(`Ранг участника на сервере **${guild.name}**`)
            .setColor('#5865F2')
            .addFields(
                { name: '📊 Уровень', value: `**${userLevel.level}**`, inline: true },
                { name: '⭐ XP', value: `**${userLevel.xp.toLocaleString()}**`, inline: true },
                { name: '💬 Сообщений', value: `**${userLevel.total_messages.toLocaleString()}**`, inline: true },
                { name: '🎊 Левел-апов', value: `**${userLevel.level_up_count}**`, inline: true },
                { name: '📈 Прогресс', value: 
                    `${'█'.repeat(Math.floor(progress.percentage / 10))}${'░'.repeat(10 - Math.floor(progress.percentage / 10))} ${Math.floor(progress.percentage)}%`,
                    inline: false }
            )
            .setFooter({ text: `До следующего уровня: ${progress.needed - progress.current} XP` })
            .setTimestamp();
        
        addImageToEmbed(card, 'rank');

        return card;
    } catch (err) {
        console.error('Ошибка генерации ранковой карточки:', err.message);
        return null;
    }
}

// Команда /rank
async function handleRankCommand(client, interaction, sendLog) {
    try {
        const targetUser = interaction.options.getUser('user') || interaction.user;
        const member = await interaction.guild.members.fetch(targetUser.id);

        const userLevel = await store.getUserLevel(interaction.guildId, targetUser.id);
        const card = await generateRankCard(interaction.guild, member, userLevel);

        if (card) {
            await interaction.reply({ embeds: [card], ephemeral: false });
        } else {
            await interaction.reply({ content: 'Ошибка генерации карточки', ephemeral: true });
        }
    } catch (err) {
        console.error('Ошибка команды /rank:', err.message);
        await interaction.reply({ content: 'Ошибка выполнения команды', ephemeral: true });
    }
}

// Команда /leaderboard
async function handleLeaderboardCommand(client, interaction) {
    try {
        const leaderboard = await store.getLeaderboard(interaction.guildId, 10);
        const guild = interaction.guild;

        if (!leaderboard || leaderboard.length === 0) {
            await interaction.reply({ content: 'Лидерборд пуст', ephemeral: true });
            return;
        }

        // Обогащаем данными пользователей
        const enriched = await Promise.all(leaderboard.map(async (entry, index) => {
            try {
                const member = await guild.members.fetch(entry.user_id);
                return {
                    rank: index + 1,
                    username: member.user.username,
                    avatar: member.user.displayAvatarURL({ size: 64 }),
                    ...entry
                };
            } catch (e) {
                return {
                    rank: index + 1,
                    username: 'Неизвестный пользователь',
                    avatar: 'https://cdn.discordapp.com/embed/avatars/0.png',
                    ...entry
                };
            }
        }));

        const card = new EmbedBuilder()
            .setTitle('🏆 Топ участников по XP')
            .setDescription('Самые активные участники сервера')
            .setColor('#FFD700')
            .addFields(
                enriched.map(entry => ({
                    name: `#${entry.rank} ${entry.username}`,
                    value: `Уровень: **${entry.level}** | XP: **${entry.xp.toLocaleString()}**`,
                    inline: false
                }))
            )
            .setTimestamp();

        addImageToEmbed(card, 'level');

        await interaction.reply({ embeds: [card], ephemeral: false });
    } catch (err) {
        console.error('Ошибка команды /leaderboard:', err.message);
        await interaction.reply({ content: 'Ошибка выполнения команды', ephemeral: true });
    }
}

// Регистрация slash-команд
async function registerCommands(client) {
    try {
        // Команда /rank
        const rankCommand = {
            name: 'rank',
            description: 'Показать вашу ранговую карточку',
            options: [
                {
                    name: 'user',
                    description: 'Пользователь для просмотра карточки',
                    type: 6, // USER
                    required: false
                }
            ]
        };

        // Команда /leaderboard
        const leaderboardCommand = {
            name: 'leaderboard',
            description: 'Показать топ участников по XP'
        };

        // Регистрируем глобальные команды
        await client.application.commands.create(rankCommand);
        await client.application.commands.create(leaderboardCommand);

        console.log('✅ Slash-команды системы уровней зарегистрированы');
    } catch (err) {
        console.error('Ошибка регистрации команд уровней:', err.message);
    }
}

// Регистрация обработчиков
module.exports = function(client, sendLog) {
    // Регистрируем команды при готовности бота
    client.once('ready', () => {
        registerCommands(client);
    });

    // Обработчик slash-команд
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isCommand()) return;

        switch (interaction.commandName) {
            case 'rank':
                await handleRankCommand(client, interaction, sendLog);
                break;
            case 'leaderboard':
                await handleLeaderboardCommand(client, interaction);
                break;
        }
    });

    // Экспортируем функцию для интеграции с analyticsTracker
    return {
        processMessageXp
    };
};