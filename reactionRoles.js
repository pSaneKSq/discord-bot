const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const store = require('./reactionRolesStore.js');

module.exports = function(client, sendLog) {
    // Обработка добавления реакции
    client.on('messageReactionAdd', async (reaction, user) => {
        // Игнорируем реакции ботов
        if (user.bot) return;

        // Проверяем что реакция на сообщении в гильдии
        if (!reaction.message.guild) return;
        
        try {
            console.log(`Reaction added: ${reaction.emoji.toString()} by ${user.tag} on message ${reaction.message.id}`);

            // Получаем информацию об автороли для этого сообщения
            const reactionRole = await store.getReactionRoleByMessage(reaction.message.guildId, reaction.message.id);
            if (!reactionRole) {
                console.log('No reaction role found for this message');
                return;
            }
            
            console.log('Reaction role found:', reactionRole.title);
            console.log('Available mappings:', reactionRole.mappings);
            
            // Ищем маппинг для этого эмодзи
            const emoji = reaction.emoji.toString();
            const mapping = reactionRole.mappings?.find(m => m.emoji === emoji);
            if (!mapping) {
                console.log(`No mapping found for emoji: ${emoji}`);
                return;
            }
            
            console.log(`Mapping found:`, mapping);
            
            // Получаем участника и роль
            const member = await reaction.message.guild.members.fetch(user.id);
            const role = reaction.message.guild.roles.cache.get(mapping.role_id);
            
            if (!role) {
                console.warn(`Роль ${mapping.role_id} не найдена для автороли ${reactionRole.id}`);
                return;
            }
            
            console.log(`Role found: ${role.name} (${role.id})`);
            
            // Проверяем может ли бот выдавать эту роль
            if (!member.roles.cache.has(mapping.role_id)) {
                try {
                    await member.roles.add(mapping.role_id);
                    console.log(`✅ Выдана роль ${role.name} пользователю ${user.tag} за реакцию ${emoji}`);
                    
                    // Логируем если включено
                    await sendLog(reaction.message.guild, 
                        `🎭 **Автороль**: <@${user.id}> получил роль **${role.name}** за реакцию ${emoji}`, 
                        'other'
                    );
                } catch (err) {
                    console.error(`❌ Ошибка выдачи роли ${role.name} пользователю ${user.tag}:`, err.message);
                }
            } else {
                console.log(`User ${user.tag} already has role ${role.name}`);
            }
        } catch (err) {
            console.error('❌ Ошибка в обработчике reactionAdd:', err.message);
            console.error('Error stack:', err.stack);
        }
    });

    // Обработка удаления реакции
    client.on('messageReactionRemove', async (reaction, user) => {
        // Игнорируем реакции ботов
        if (user.bot) return;

        // Проверяем что реакция на сообщении в гильдии
        if (!reaction.message.guild) return;
        
        try {
            console.log(`Reaction removed: ${reaction.emoji.toString()} by ${user.tag} on message ${reaction.message.id}`);

            // Получаем информацию об автороли для этого сообщения
            const reactionRole = await store.getReactionRoleByMessage(reaction.message.guildId, reaction.message.id);
            if (!reactionRole) {
                console.log('No reaction role found for this message');
                return;
            }
            
            // Ищем маппинг для этого эмодзи
            const emoji = reaction.emoji.toString();
            const mapping = reactionRole.mappings?.find(m => m.emoji === emoji);
            if (!mapping) {
                console.log(`No mapping found for emoji: ${emoji}`);
                return;
            }
            
            // Получаем участника и роль
            const member = await reaction.message.guild.members.fetch(user.id);
            const role = reaction.message.guild.roles.cache.get(mapping.role_id);
            
            if (!role) {
                console.warn(`Роль ${mapping.role_id} не найдена для автороли ${reactionRole.id}`);
                return;
            }
            
            // Проверяем есть ли у пользователя эта роль
            if (member.roles.cache.has(mapping.role_id)) {
                try {
                    await member.roles.remove(mapping.role_id);
                    console.log(`✅ Снята роль ${role.name} с пользователя ${user.tag} после удаления реакции ${emoji}`);
                    
                    // Логируем если включено
                    await sendLog(reaction.message.guild, 
                        `🎭 **Автороль**: <@${user.id}> потерял роль **${role.name}** после удаления реакции ${emoji}`, 
                        'other'
                    );
                } catch (err) {
                    console.error(`❌ Ошибка снятия роли ${role.name} с пользователя ${user.tag}:`, err.message);
                }
            }
        } catch (err) {
            console.error('❌ Ошибка в обработчике reactionRemove:', err.message);
            console.error('Error stack:', err.stack);
        }
    });

    // Функция для создания эмбед сообщения автороли
    async function createReactionRoleEmbed(reactionRole) {
        const embed = new EmbedBuilder()
            .setTitle(reactionRole.title)
            .setDescription(reactionRole.description || 'Выберите роль, нажав на соответствующую реакцию:')
            .setColor(reactionRole.color || '#5865F2')
            .setTimestamp();
        
        const files = [];
        
        // Добавляем изображение если есть
        if (reactionRole.image) {
            if (reactionRole.image.startsWith('data:')) {
                // Обработка base64 изображения (как в announcements.js)
                try {
                    const comma = reactionRole.image.indexOf(',');
                    const header = reactionRole.image.slice(0, comma);
                    const base64 = reactionRole.image.slice(comma + 1);
                    const ext = header.match(/image\/(png|jpe?g|gif|webp)/i)[1].toLowerCase().replace('jpeg', 'jpg');
                    const fileName = `reaction-role-image.${ext}`;
                    files.push(new AttachmentBuilder(Buffer.from(base64, 'base64'), { name: fileName }));
                    embed.setImage(`attachment://${fileName}`);
                } catch (err) {
                    console.warn('Ошибка обработки base64 изображения:', err.message);
                }
            } else {
                // Обработка обычного URL
                try {
                    embed.setImage(reactionRole.image);
                } catch (err) {
                    console.warn('Ошибка установки изображения URL:', err.message);
                }
            }
        }
        
        // Добавляем поля для каждой реакции-роли
        if (reactionRole.mappings && reactionRole.mappings.length > 0) {
            const fieldValue = reactionRole.mappings
                .map(m => `${m.emoji} — ${m.label || 'Роль'}`)
                .join('\n');
            
            embed.addFields({
                name: 'Доступные роли',
                value: fieldValue
            });
        }
        
        return { embed, files };
    }

    // Функция для обновления сообщения автороли
    async function updateReactionRoleMessage(guildId, reactionRoleId) {
        try {
            const reactionRole = await store.getReactionRoleById(guildId, reactionRoleId);
            if (!reactionRole || !reactionRole.guild_id || !reactionRole.channel_id || !reactionRole.message_id) {
                return false;
            }

            const guild = client.guilds.cache.get(reactionRole.guild_id);
            if (!guild) return false;

            const channel = await guild.channels.fetch(reactionRole.channel_id);
            if (!channel || !channel.isTextBased()) return false;

            const message = await channel.messages.fetch(reactionRole.message_id);
            if (!message) return false;

            const { embed, files } = await createReactionRoleEmbed(reactionRole);
            await message.edit({ embeds: [embed], files, attachments: [] });

            return true;
        } catch (err) {
            console.error('❌ Ошибка обновления сообщения автороли:', err.message);
            return false;
        }
    }

    // Экспортируем вспомогательные функции для использования в API
    return {
        createReactionRoleEmbed,
        updateReactionRoleMessage
    };
};