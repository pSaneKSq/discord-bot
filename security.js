const store = require('./securityStore.js');

// Типы ограничений
const RESTRICTION_TYPES = {
    ROLE_EDIT: 'role_edit',
    ROLE_CREATE: 'role_create',
    ROLE_DELETE: 'role_delete',
    UNBAN: 'unban',
    UNMUTE: 'unmute',
    CHANNEL_DELETE: 'channel_delete',
    CHANNEL_CREATE: 'channel_create',
    ADMIN_CHANGE: 'admin_change',
    MASS_ACTION: 'mass_action',
    SERVER_SETTINGS: 'server_settings',
    SERVER_RENAME: 'server_rename',
    WEBHOOK_MANAGE: 'webhook_manage',
    AUTO_BAN: 'auto_ban',
    AUTO_KICK: 'auto_kick',
    AUTO_DEMOTE: 'auto_demote'
};

// Методы ограничений
const RESTRICTION_METHODS = {
    BLOCK: 'block',
    CONFIRM: 'confirm',
    DELAY: 'delay',
    LOG: 'log'
};

// Хранилище для ожидающих подтверждений
const pendingConfirmations = new Map();

// Результаты проверки
const CHECK_RESULTS = {
    ALLOWED: 'allowed',
    BLOCKED: 'blocked',
    PENDING_CONFIRM: 'pending_confirm',
    PENDING_DELAY: 'pending_delay'
};

class SecuritySystem {
    constructor(client, sendLog) {
        this.client = client;
        this.sendLog = sendLog;
        this.BOT_ID = client.user?.id;
        this.OWNER_ID = process.env.OWNER_DISCORD_ID;
    }

    // Проверить, включена ли система защиты
    async isEnabled(guildId) {
        let settings = await store.getSecuritySettings(guildId);

        // Если настроек нет, создаем их с включенной защитой
        if (!settings) {
            console.log('🛡️ Настройки защиты не найдены, создаем с включенной защитой');
            settings = await store.upsertSecuritySettings(guildId, { enabled: true });
        }

        const enabled = settings && settings.enabled;
        console.log(`🛡️ Система защиты ${enabled ? 'ВКЛЮЧЕНА' : 'ВЫКЛЮЧЕНА'}`);
        return enabled;
    }

    // Проверить, находится ли пользователь в белом списке
    async isWhitelisted(guildId, userId) {
        // Владелец всегда в белом списке
        if (userId === this.OWNER_ID) return true;
        // Бот всегда в белом списке
        if (userId === this.BOT_ID) return true;
        // Проверка в БД
        return await store.isInWhitelist(guildId, userId);
    }

    // Проверить ограничение для пользователя
    async checkRestriction(guildId, userId, restrictionType) {
        console.log(`🛡️ Проверка ограничения: userId=${userId}, type=${restrictionType}`);

        // Если в белом списке - разрешить
        const whitelisted = await this.isWhitelisted(guildId, userId);
        console.log(`🛡️ В белом списке: ${whitelisted}`);

        if (whitelisted) {
            return { allowed: true, result: CHECK_RESULTS.ALLOWED, reason: 'whitelisted' };
        }

        // Проверить наличие ограничения
        const restriction = await store.hasRestriction(guildId, userId, restrictionType);
        console.log(`🛡️ Найдено ограничение:`, restriction);

        if (!restriction) {
            return { allowed: true, result: CHECK_RESULTS.ALLOWED, reason: 'no_restriction' };
        }

        // Проверить метод ограничения
        switch (restriction.restriction_method) {
            case RESTRICTION_METHODS.BLOCK:
                console.log(`🛡️ Метод: BLOCK - блокируем действие`);
                return { allowed: false, result: CHECK_RESULTS.BLOCKED, method: 'block', restriction };
            case RESTRICTION_METHODS.CONFIRM:
                console.log(`🛡️ Метод: CONFIRM - требуем подтверждение`);
                return { allowed: false, result: CHECK_RESULTS.PENDING_CONFIRM, method: 'confirm', restriction };
            case RESTRICTION_METHODS.DELAY:
                console.log(`🛡️ Метод: DELAY - задержка`);
                return { allowed: false, result: CHECK_RESULTS.PENDING_DELAY, method: 'delay', restriction };
            case RESTRICTION_METHODS.LOG:
                console.log(`🛡️ Метод: LOG - только логируем`);
                return { allowed: true, result: CHECK_RESULTS.ALLOWED, method: 'log', restriction };
            default:
                console.log(`🛡️ Неизвестный метод: ${restriction.restriction_method} - разрешаем`);
                return { allowed: true, result: CHECK_RESULTS.ALLOWED, reason: 'unknown_method' };
        }
    }

    // Запрос подтверждения действия через голосование
    async requestConfirmation(guildId, userId, actionType, details, targetMember = null) {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) return false;

            const executor = await guild.members.fetch(userId).catch(() => null);
            if (!executor) return false;

            console.log(`🛡️ 📧 Создание голосования для подтверждения действия от ${executor.user.username}`);

            // Получаем белый список
            const whitelist = await store.getWhitelist(guildId);
            if (whitelist.length === 0) {
                console.log('�️ ⚠️ Белый список пуст, некому голосовать');
                return false;
            }

            // Создаем ID голосования
            const voteId = `vote_${Date.now()}_${userId}`;
            const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 минут

            // Создаем запись голосования в БД
            const targetUserId = targetMember ? targetMember.id : null;
            const targetUserName = targetMember ? targetMember.user.username : 'N/A';

            await store.createVote(
                guildId,
                voteId,
                actionType,
                targetUserId,
                targetUserName,
                userId,
                executor.user.username,
                details,
                expiresAt
            );

            console.log(`🛡️ ✅ Голосование создано: ${voteId}`);

            // Отправляем запросы всем в белом списке
            const settings = await store.getSecuritySettings(guildId);
            let successCount = 0;

            for (const whitelistUser of whitelist) {
                try {
                    const member = await guild.members.fetch(whitelistUser.user_id).catch(() => null);
                    if (!member) continue;

                    // Создаем сообщение для голосования
                    const voteMessage = `
🔔 **Запрос подтверждения действия - Голосование #${voteId}**

**Действие:** ${actionType}
**Исполнитель:** <@${userId}> (${executor.user.username})
**Цель:** ${targetMember ? `<@${targetMember.id}> (${targetMember.user.username})` : 'N/A'}
**Детали:** ${details}

⚠️ Это действие требует подтверждения большинства голосов из белого списка.
✅ Проголосуйте ЗА нажав на реакцию ✅
❌ Проголосуйте ПРОТИВ нажав на реакцию ❌

У вас есть 5 минут для голосования.
Текущее время: ${new Date().toLocaleString('ru-RU')}
Голосование истекает: ${expiresAt.toLocaleString('ru-RU')}
`;

                    // Пытаемся отправить DM
                    try {
                        const dmChannel = await member.createDM();
                        const message = await dmChannel.send(voteMessage);
                        
                        // Добавляем реакции
                        await message.react('✅');
                        await message.react('❌');
                        
                        successCount++;
                        console.log(`🛡️ ✅ Запрос отправлен ${member.user.username}`);
                    } catch (dmErr) {
                        console.error(`🛡️ ❌ Не удалось отправить DM ${member.user.username}:`, dmErr.message);
                        // Если DM не работает, отправляем в системный канал
                        if (settings && settings.notification_channel_id) {
                            const channel = await guild.channels.fetch(settings.notification_channel_id);
                            if (channel) {
                                const msg = await channel.send(`<@${whitelistUser.user_id}> ${voteMessage}`);
                                await msg.react('✅');
                                await msg.react('❌');
                                successCount++;
                            }
                        }
                    }
                } catch (err) {
                    console.error(`🛡️ ❌ Ошибка при отправке запроса ${whitelistUser.user_id}:`, err.message);
                }
            }

            console.log(`🛡️ 📊 Запросы отправлены ${successCount}/${whitelist.length} пользователям из белого списка`);

            // Запускаем таймер для проверки результатов голосования
            setTimeout(() => this.checkVoteResults(guildId, voteId, actionType, targetMember, userId, details), 5 * 60 * 1000);

            return successCount > 0;
        } catch (err) {
            console.error('🛡️ ❌ Ошибка запроса подтверждения:', err.message);
            return false;
        }
    }

    // Логировать действие
    async logAction(guildId, userId, userName, actionType, restrictionType, result, details = null) {
        try {
            await store.addSecurityLog(
                guildId,
                userId,
                userName,
                actionType,
                restrictionType,
                result,
                details
            );
        } catch (err) {
            console.error('Ошибка логирования действия защиты:', err.message);
        }
    }

    // Отправить уведомление о нарушении
    async sendNotification(guildId, userId, userName, actionType, restriction) {
        try {
            const settings = await store.getSecuritySettings(guildId);
            if (!settings || !settings.notification_channel_id) return;

            const channel = await this.client.channels.fetch(settings.notification_channel_id);
            if (!channel) return;

            const notification = `🛡️ **Защита сервера**

**Пользователь:** <@${userId}> (${userName})
**Действие:** ${actionType}
**Ограничение:** ${restriction.restriction_type}
**Метод:** ${restriction.restriction_method}

${restriction.notification_enabled ? '🔔 Уведомление включено' : ''}`;

            await channel.send(notification);
        } catch (err) {
            console.error('Ошибка отправки уведомления защиты:', err.message);
        }
    }

    // Обработчик события редактирования роли
    async handleRoleUpdate(oldRole, newRole) {
        const guildId = newRole.guild.id;
        if (!(await this.isEnabled(guildId))) return;

        try {
            const guild = newRole.guild;

            // Получаем аудит лог чтобы узнать кто изменил роль
            const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 31 });
            const entry = auditLogs.entries.first();

            if (!entry || !entry.executor) return;

            const executor = entry.executor;
            if (executor.bot) return;

            const check = await this.checkRestriction(guildId, executor.id, RESTRICTION_TYPES.ROLE_EDIT);

            const userName = executor.username;
            const details = `Роль: ${newRole.name} (${newRole.id}). Изменения: название/права/цвет`;

            console.log(`🛡️ Проверка редактирования роли: ${executor.username} -> ${check.allowed ? 'РАЗРЕШЕНО' : 'ЗАПРЕЩЕНО'}`);

            if (!check.allowed) {
                // Попытка отката изменений (если возможно)
                try {
                    await newRole.edit({
                        name: oldRole.name,
                        color: oldRole.color,
                        permissions: oldRole.permissions,
                        position: oldRole.position,
                        hoist: oldRole.hoist,
                        mentionable: oldRole.mentionable
                    });
                    console.log(`🛡️ Откат изменений роли ${newRole.name} выполнен`);
                } catch (rollbackErr) {
                    console.error('Не удалось откатить изменения роли:', rollbackErr.message);
                }

                await this.logAction(guildId, executor.id, userName, 'ROLE_UPDATE', RESTRICTION_TYPES.ROLE_EDIT, check.result, details);

                if (check.method === 'block' && check.restriction?.notification_enabled) {
                    await this.sendNotification(guildId, executor.id, userName, 'Редактирование роли', check.restriction);
                }

                // Проверяем автоматические наказания
                await this.checkAutoPunishments(guildId, executor, 'role_edit');
            } else {
                await this.logAction(guildId, executor.id, userName, 'ROLE_UPDATE', RESTRICTION_TYPES.ROLE_EDIT, CHECK_RESULTS.ALLOWED, details);
            }
        } catch (err) {
            console.error('Ошибка в обработчике roleUpdate:', err.message);
        }
    }

    // Обработчик события разбанивания
    async handleGuildBanRemove(ban) {
        console.log('🛡️ Событие разбанивания сработало!');

        const guild = ban.guild;
        if (!(await this.isEnabled(guild.id))) {
            console.log('🛡️ Система защиты выключена, пропускаем проверку');
            return;
        }

        try {

            console.log(`🛡️ Разбанен пользователь: ${ban.user.username} (${ban.user.id})`);

            const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 22 });
            const entry = auditLogs.entries.first();
            
            if (!entry || !entry.executor) {
                console.log('🛡️ Не удалось получить информацию об исполнителе из audit logs');
                return;
            }

            const executor = entry.executor;
            console.log(`🛡️ Исполнитель: ${executor.username} (${executor.id}), бот: ${executor.bot}`);
            
            if (executor.bot) {
                console.log('🛡️ Исполнитель - бот, пропускаем');
                return;
            }

            const check = await this.checkRestriction(guild.id, executor.id, RESTRICTION_TYPES.UNBAN);
            console.log(`🛡️ Проверка ограничения для ${executor.username}:`, check);
            
            const userName = executor.username;
            const details = `Разбанен пользователь: ${ban.user.username} (${ban.user.id})`;

            if (!check.allowed) {
                console.log(`🛡️ 🚫 РАЗБАНИВАНИЕ ЗАБЛОКИРОВАНО для ${executor.username}!`);
                
                const method = check.restriction?.restriction_method || 'block';
                
                if (method === 'confirm') {
                    console.log(`🛡️ 📧 Запрос подтверждения для разбанивания`);
                    await this.requestConfirmation(guild.id, executor.id, 'Разбанивание', details, null);
                } else {
                    // Пытаемся вернуть бан
                    try {
                        await guild.members.ban(ban.user.id, { reason: 'Автоматический возврат бана (система защиты)' });
                        console.log('🛡️ Бан возвращен');
                    } catch (rollbackErr) {
                        console.error('Не удалось вернуть бан:', rollbackErr.message);
                    }
                }

                await this.logAction(guild.id, executor.id, userName, 'GUILD_BAN_REMOVE', RESTRICTION_TYPES.UNBAN, check.result, details);
                
                if (method === 'block' && check.restriction?.notification_enabled) {
                    await this.sendNotification(guild.id, executor.id, userName, 'Разбанивание', check.restriction);
                }

                // Проверяем автоматические наказания
                await this.checkAutoPunishments(guild.id, executor, 'unban');
            } else {
                console.log(`🛡️ ✅ Разбанивание РАЗРЕШЕНО для ${executor.username}`);
                await this.logAction(guild.id, executor.id, userName, 'GUILD_BAN_REMOVE', RESTRICTION_TYPES.UNBAN, CHECK_RESULTS.ALLOWED, details);
            }
        } catch (err) {
            console.error('❌ Ошибка в обработчике guildBanRemove:', err.message);
            console.error('❌ Stack:', err.stack);
        }
    }

    // Обработчик события обновления участника (для размучивания и прав админа)
    async handleGuildMemberUpdate(oldMember, newMember) {
        const guild = newMember.guild;
        if (!(await this.isEnabled(guild.id))) return;

        try {

            // Проверяем были ли убраны таймауты (муты)
            const oldTimeout = oldMember.communicationDisabledUntil;
            const newTimeout = newMember.communicationDisabledUntil;

            // Если был мут и его убрали
            if (oldTimeout && oldTimeout > Date.now() && (!newTimeout || newTimeout <= Date.now())) {
                console.log('🛡️ Обнаружено снятие мута с участника!');
                
                const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 24 });
                const entry = auditLogs.entries.first();
                
                if (!entry || !entry.executor) {
                    console.log('🛡️ Не удалось получить информацию об исполнителе из audit logs');
                    return;
                }

                const executor = entry.executor;
                console.log(`🛡️ Исполнитель снятия мута: ${executor.username} (${executor.id}), бот: ${executor.bot}`);
                
                if (executor.bot) {
                    console.log('🛡️ Исполнитель - бот, пропускаем');
                    return;
                }

                const check = await this.checkRestriction(guild.id, executor.id, RESTRICTION_TYPES.UNMUTE);
                console.log(`🛡️ Проверка ограничения для ${executor.username}:`, check);
                
                const userName = executor.username;
                const details = `Снят мут с участника: ${newMember.user.username} (${newMember.user.id})`;

                if (!check.allowed) {
                    console.log(`🛡️ 🚫 СНЯТИЕ МУТА ЗАБЛОКИРОВАНО для ${executor.username}!`);
                    
                    const method = check.restriction?.restriction_method || 'block';
                    
                    if (method === 'confirm') {
                        console.log(`🛡️ 📧 Запрос подтверждения для снятия мута`);
                        await this.requestConfirmation(guild.id, executor.id, 'Снятие мута', details, newMember);
                    } else {
                        // Пытаемся вернуть мут
                        try {
                            // Возвращаем мут на то же время, что был originally
                            const timeoutDuration = oldTimeout - Date.now();
                            await newMember.timeout(timeoutDuration, 'Автоматический возврат мута (система защиты)');
                            console.log(`🛡️ Мут возвращен на ${timeoutDuration}ms`);
                        } catch (rollbackErr) {
                            console.error('Не удалось вернуть мут:', rollbackErr.message);
                        }
                    }

                    await this.logAction(guild.id, executor.id, userName, 'GUILD_MEMBER_UPDATE', RESTRICTION_TYPES.UNMUTE, check.result, details);
                    
                    if (method === 'block' && check.restriction?.notification_enabled) {
                        await this.sendNotification(guild.id, executor.id, userName, 'Снятие мута', check.restriction);
                    }

                    // Проверяем автоматические наказания
                    await this.checkAutoPunishments(guild.id, executor, 'unmute');
                } else {
                    console.log(`🛡️ ✅ Снятие мута РАЗРЕШЕНО для ${executor.username}`);
                    await this.logAction(guild.id, executor.id, userName, 'GUILD_MEMBER_UPDATE', RESTRICTION_TYPES.UNMUTE, CHECK_RESULTS.ALLOWED, details);
                }
            }

            // Проверяем добавление прав администратора
            const oldAdmin = oldMember.permissions.has('Administrator');
            const newAdmin = newMember.permissions.has('Administrator');

            if (!oldAdmin && newAdmin) {
                console.log('🛡️ Обнаружено добавление прав администратора!');
                
                // Был добавлен административный доступ
                const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 25 });
                const entry = auditLogs.entries.first();
                
                if (!entry || !entry.executor) return;

                const executor = entry.executor;
                if (executor.bot) return;

                const check = await this.checkRestriction(guild.id, executor.id, RESTRICTION_TYPES.ADMIN_CHANGE);
                console.log(`🛡️ Проверка ограничения для ${executor.username}:`, check);
                
                const userName = executor.username;
                const details = `Выданы права администратора участнику: ${newMember.user.username} (${newMember.user.id})`;

                if (!check.allowed) {
                    console.log(`🛡️ 🚫 ВЫДАЧА ПРАВ АДМИНА ЗАБЛОКИРОВАНА для ${executor.username}!`);
                    
                    // Пытаемся убрать права администратора
                    try {
                        await newMember.roles.remove(newMember.roles.cache.filter(r => r.permissions.has('Administrator')));
                        console.log('🛡️ Права администратора убраны');
                    } catch (rollbackErr) {
                        console.error('Не удалось убрать права администратора:', rollbackErr.message);
                    }

                    await this.logAction(guild.id, executor.id, userName, 'GUILD_MEMBER_UPDATE', RESTRICTION_TYPES.ADMIN_CHANGE, check.result, details);
                    
                    const method = check.restriction?.restriction_method || 'block';
                    if (method === 'block' && check.restriction?.notification_enabled) {
                        await this.sendNotification(guild.id, executor.id, userName, 'Изменение прав администратора', check.restriction);
                    }
                } else {
                    console.log(`🛡️ ✅ Выдача прав админа РАЗРЕШЕНА для ${executor.username}`);
                    await this.logAction(guild.id, executor.id, userName, 'GUILD_MEMBER_UPDATE', RESTRICTION_TYPES.ADMIN_CHANGE, CHECK_RESULTS.ALLOWED, details);
                }
            }
        } catch (err) {
            console.error('❌ Ошибка в обработчике guildMemberUpdate:', err.message);
            console.error('❌ Stack:', err.stack);
        }
    }

    // Обработчик события удаления канала
    async handleChannelDelete(channel) {
        console.log('🛡️ Событие удаления канала сработало!');

        const guild = channel.guild;
        if (!(await this.isEnabled(guild.id))) {
            console.log('🛡️ Система защиты выключена, пропускаем проверку');
            return;
        }

        try {

            console.log(`🛡️ Удален канал: ${channel.name} (${channel.id})`);
            
            const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 12 });
            const entry = auditLogs.entries.first();
            
            if (!entry || !entry.executor) {
                console.log('🛡️ Не удалось получить информацию об исполнителе из audit logs');
                return;
            }

            const executor = entry.executor;
            console.log(`🛡️ Исполнитель: ${executor.username} (${executor.id}), бот: ${executor.bot}`);
            
            // Проверяем - это наш бот удаляет канал VoiceMaster?
            if (executor.bot && executor.id === this.BOT_ID) {
                console.log('🛡️ Наш бот удаляет канал (VoiceMaster автоудаление), пропускаем');
                return;
            }
            
            if (executor.bot) {
                console.log('🛡️ Исполнитель - другой бот, пропускаем');
                return;
            }

            const check = await this.checkRestriction(guild.id, executor.id, RESTRICTION_TYPES.CHANNEL_DELETE);
            console.log(`🛡️ Проверка ограничения для ${executor.username}:`, check);
            
            const userName = executor.username;
            const details = `Удален канал: ${channel.name} (${channel.id}), тип: ${channel.type}`;

            if (!check.allowed) {
                console.log(`🛡️ 🚫 УДАЛЕНИЕ КАНАЛА ЗАБЛОКИРОВАНО для ${executor.username}!`);
                console.log(`🛡️ ⚠️ Канал уже удалён и не может быть восстановлен через Discord API`);
                
                await this.logAction(guild.id, executor.id, userName, 'CHANNEL_DELETE', RESTRICTION_TYPES.CHANNEL_DELETE, check.result, details);
                
                const method = check.restriction?.restriction_method || 'block';
                console.log(`🛡️ Метод ограничения: ${method}, уведомления: ${check.restriction?.notification_enabled}`);
                
                if (method === 'block' && check.restriction?.notification_enabled) {
                    await this.sendNotification(guild.id, executor.id, userName, 'Удаление канала', check.restriction);
                }
            } else {
                console.log(`🛡️ ✅ Удаление канала РАЗРЕШЕНО для ${executor.username}`);
                await this.logAction(guild.id, executor.id, userName, 'CHANNEL_DELETE', RESTRICTION_TYPES.CHANNEL_DELETE, CHECK_RESULTS.ALLOWED, details);
            }
        } catch (err) {
            console.error('❌ Ошибка в обработчике channelDelete:', err.message);
            console.error('❌ Stack:', err.stack);
        }
    }

    // Обработчик события обновления сервера (переименование и т.д.)
    async handleGuildUpdate(oldGuild, newGuild) {
        if (!(await this.isEnabled(newGuild.id))) return;

        try {

            // Проверяем переименование сервера
            if (oldGuild.name !== newGuild.name) {
                const auditLogs = await newGuild.fetchAuditLogs({ limit: 1, type: 1 });
                const entry = auditLogs.entries.first();
                
                if (!entry || !entry.executor) return;

                const executor = entry.executor;
                if (executor.bot) return;

                const check = await this.checkRestriction(newGuild.id, executor.id, RESTRICTION_TYPES.SERVER_RENAME);
                
                const userName = executor.username;
                const details = `Сервер переименован с "${oldGuild.name}" на "${newGuild.name}"`;

                if (!check.allowed) {
                    // Пытаемся вернуть старое название
                    try {
                        await newGuild.setName(oldGuild.name);
                    } catch (rollbackErr) {
                        console.error('Не удалось вернуть название сервера:', rollbackErr.message);
                    }

                    await this.logAction(newGuild.id, executor.id, userName, 'GUILD_UPDATE', RESTRICTION_TYPES.SERVER_RENAME, check.result, details);
                    
                    if (check.method === 'block' && check.restriction?.notification_enabled) {
                        await this.sendNotification(newGuild.id, executor.id, userName, 'Переименование сервера', check.restriction);
                    }
                } else {
                    await this.logAction(newGuild.id, executor.id, userName, 'GUILD_UPDATE', RESTRICTION_TYPES.SERVER_RENAME, CHECK_RESULTS.ALLOWED, details);
                }
            }
        } catch (err) {
            console.error('Ошибка в обработчике guildUpdate:', err.message);
        }
    }

    // Обработчик события создания роли
    async handleRoleCreate(role) {
        const guild = role.guild;
        if (!(await this.isEnabled(guild.id))) return;

        try {

            const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 30 });
            const entry = auditLogs.entries.first();
            
            if (!entry || !entry.executor) return;

            const executor = entry.executor;
            if (executor.bot) return;

            const check = await this.checkRestriction(guild.id, executor.id, RESTRICTION_TYPES.ROLE_CREATE);
            
            const userName = executor.username;
            const details = `Создана роль: ${role.name} (${role.id})`;

            if (!check.allowed) {
                // Пытаемся удалить роль
                try {
                    await role.delete('Автоматическое удаление (система защиты)');
                } catch (rollbackErr) {
                    console.error('Не удалось удалить роль:', rollbackErr.message);
                }

                await this.logAction(guild.id, executor.id, userName, 'ROLE_CREATE', RESTRICTION_TYPES.ROLE_CREATE, check.result, details);
                
                if (check.method === 'block' && check.restriction?.notification_enabled) {
                    await this.sendNotification(guild.id, executor.id, userName, 'Создание роли', check.restriction);
                }
            } else {
                await this.logAction(guild.id, executor.id, userName, 'ROLE_CREATE', RESTRICTION_TYPES.ROLE_CREATE, CHECK_RESULTS.ALLOWED, details);
            }
        } catch (err) {
            console.error('Ошибка в обработчике roleCreate:', err.message);
        }
    }

    // Обработчик события удаления роли
    async handleRoleDelete(role) {
        console.log('🛡️ Событие удаления роли сработало!');

        const guild = role.guild;
        if (!(await this.isEnabled(guild.id))) {
            console.log('🛡️ Система защиты выключена, пропускаем проверку');
            return;
        }

        try {

            console.log(`🛡️ Удалена роль: ${role.name} (${role.id})`);

            const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 32 });
            const entry = auditLogs.entries.first();
            
            if (!entry || !entry.executor) {
                console.log('🛡️ Не удалось получить информацию об исполнителе из audit logs');
                return;
            }

            const executor = entry.executor;
            console.log(`🛡️ Исполнитель: ${executor.username} (${executor.id}), бот: ${executor.bot}`);
            
            if (executor.bot) {
                console.log('🛡️ Исполнитель - бот, пропускаем');
                return;
            }

            const check = await this.checkRestriction(guild.id, executor.id, RESTRICTION_TYPES.ROLE_DELETE);
            console.log(`🛡️ Проверка ограничения для ${executor.username}:`, check);
            
            const userName = executor.username;
            const details = `Удалена роль: ${role.name} (${role.id})`;

            if (!check.allowed) {
                console.log(`🛡️ 🚫 УДАЛЕНИЕ РОЛИ ЗАБЛОКИРОВАНО для ${executor.username}!`);
                console.log(`🛡️ 🔧 Попытка восстановления роли...`);
                
                // Сохраняем данные роли для восстановления
                const roleData = {
                    name: role.name,
                    color: role.color,
                    permissions: role.permissions.bitfield,
                    hoist: role.hoist,
                    mentionable: role.mentionable,
                    position: role.position
                };

                // Пытаемся восстановить роль
                try {
                    console.log(`🛡️ Создание новой роли с параметрами:`, roleData);
                    const newRole = await guild.roles.create({
                        name: roleData.name,
                        color: roleData.color,
                        permissions: roleData.permissions,
                        hoist: roleData.hoist,
                        mentionable: roleData.mentionable,
                        reason: 'Автоматическое восстановление удалённой роли (система защиты)'
                    });

                    console.log(`🛡️ ✅ Роль восстановлена: ${newRole.name} (${newRole.id})`);

                    // Пытаемся восстановить позицию роли
                    try {
                        await newRole.setPosition(roleData.position);
                        console.log(`🛡️ ✅ Позиция роли восстановлена`);
                    } catch (posErr) {
                        console.error('🛡️ ⚠️ Не удалось восстановить позицию роли:', posErr.message);
                    }

                    // Восстанавливаем роли пользователям из audit logs
                    try {
                        // Получаем последних 100 записей о назначении этой роли
                        const roleAssignLogs = await guild.fetchAuditLogs({ 
                            limit: 100, 
                            type: 25  // MEMBER_ROLE_UPDATE
                        });

                        const usersToRestore = new Set();
                        roleAssignLogs.entries.forEach(logEntry => {
                            if (logEntry.changes && logEntry.changes.some(change => 
                                change.key === '$add' && change.new && change.new.some(r => r === role.id)
                            )) {
                                usersToRestore.add(logEntry.target.id);
                            }
                        });

                        console.log(`🛡️ Найдено ${usersToRestore.size} пользователей для восстановления роли`);

                        // Выдаём восстановленную роль пользователям
                        let restoredCount = 0;
                        for (const userId of usersToRestore) {
                            try {
                                const member = await guild.members.fetch(userId);
                                await member.roles.add(newRole.id);
                                restoredCount++;
                                console.log(`🛡️ ✅ Роль выдана пользователю: ${member.user.username}`);
                            } catch (memberErr) {
                                console.error(`🛡️ ⚠️ Не удалось выдать роль пользователю ${userId}:`, memberErr.message);
                            }
                        }

                        console.log(`🛡️ ✅ Роль восстановлена и выдана ${restoredCount} пользователям`);
                        details += `. Восстановлено: новая роль ${newRole.id}, выдано ${restoredCount} пользователям`;

                    } catch (restoreErr) {
                        console.error('🛡️ ⚠️ Не удалось восстановить роли пользователям:', restoreErr.message);
                        details += `. Восстановлена только роль (без пользователей)`;
                    }

                } catch (restoreErr) {
                    console.error('🛡️ ❌ Не удалось восстановить роль:', restoreErr.message);
                    details += `. Ошибка восстановления: ${restoreErr.message}`;
                }

                await this.logAction(guild.id, executor.id, userName, 'ROLE_DELETE', RESTRICTION_TYPES.ROLE_DELETE, check.result, details);
                
                const method = check.restriction?.restriction_method || 'block';
                if (method === 'block' && check.restriction?.notification_enabled) {
                    await this.sendNotification(guild.id, executor.id, userName, 'Удаление роли', check.restriction);
                }

                // Проверяем автоматические наказания
                await this.checkAutoPunishments(guild.id, executor, 'role_delete');
            } else {
                console.log(`🛡️ ✅ Удаление роли РАЗРЕШЕНО для ${executor.username}`);
                await this.logAction(guild.id, executor.id, userName, 'ROLE_DELETE', RESTRICTION_TYPES.ROLE_DELETE, CHECK_RESULTS.ALLOWED, details);
            }
        } catch (err) {
            console.error('❌ Ошибка в обработчике roleDelete:', err.message);
            console.error('❌ Stack:', err.stack);
        }
    }

    // Обработчик события создания канала
    async handleChannelCreate(channel) {
        const guild = channel.guild;
        if (!(await this.isEnabled(guild.id))) return;

        try {

            const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 10 });
            const entry = auditLogs.entries.first();
            
            if (!entry || !entry.executor) return;

            const executor = entry.executor;
            if (executor.bot) return;

            const check = await this.checkRestriction(guild.id, executor.id, RESTRICTION_TYPES.CHANNEL_CREATE);
            
            const userName = executor.username;
            const details = `Создан канал: ${channel.name} (${channel.id}), тип: ${channel.type}`;

            if (!check.allowed) {
                // Пытаемся удалить канал
                try {
                    await channel.delete('Автоматическое удаление (система защиты)');
                } catch (rollbackErr) {
                    console.error('Не удалось удалить канал:', rollbackErr.message);
                }

                await this.logAction(guild.id, executor.id, userName, 'CHANNEL_CREATE', RESTRICTION_TYPES.CHANNEL_CREATE, check.result, details);
                
                if (check.method === 'block' && check.restriction?.notification_enabled) {
                    await this.sendNotification(guild.id, executor.id, userName, 'Создание канала', check.restriction);
                }
            } else {
                await this.logAction(guild.id, executor.id, userName, 'CHANNEL_CREATE', RESTRICTION_TYPES.CHANNEL_CREATE, CHECK_RESULTS.ALLOWED, details);
            }
        } catch (err) {
            console.error('Ошибка в обработчике channelCreate:', err.message);
        }
    }

    // Обработчик события создания/удаления вебхука
    async handleWebhookUpdate(channel) {
        const guild = channel.guild;
        if (!(await this.isEnabled(guild.id))) return;

        try {

            const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: [50, 51] });
            const entry = auditLogs.entries.first();
            
            if (!entry || !entry.executor) return;

            const executor = entry.executor;
            if (executor.bot) return;

            const check = await this.checkRestriction(guild.id, executor.id, RESTRICTION_TYPES.WEBHOOK_MANAGE);
            
            const userName = executor.username;
            const actionType = entry.action === 50 ? 'WEBHOOK_CREATE' : 'WEBHOOK_DELETE';
            const details = `Вебхук в канале: ${channel.name} (${channel.id})`;

            if (!check.allowed) {
                await this.logAction(guild.id, executor.id, userName, actionType, RESTRICTION_TYPES.WEBHOOK_MANAGE, check.result, details);
                
                if (check.method === 'block' && check.restriction?.notification_enabled) {
                    await this.sendNotification(guild.id, executor.id, userName, 'Управление вебхуками', check.restriction);
                }
            } else {
                await this.logAction(guild.id, executor.id, userName, actionType, RESTRICTION_TYPES.WEBHOOK_MANAGE, CHECK_RESULTS.ALLOWED, details);
            }
        } catch (err) {
            console.error('Ошибка в обработчике webhookUpdate:', err.message);
        }
    }

    // Инициализация системы защиты
    initialize() {
        console.log('🛡️ Инициализация системы защиты сервера...');

        // Регистрация обработчиков событий
        this.client.on('roleUpdate', (oldRole, newRole) => this.handleRoleUpdate(oldRole, newRole));
        this.client.on('roleCreate', (role) => this.handleRoleCreate(role));
        this.client.on('roleDelete', (role) => this.handleRoleDelete(role));
        this.client.on('guildBanRemove', (ban) => this.handleGuildBanRemove(ban));
        this.client.on('channelDelete', (channel) => this.handleChannelDelete(channel));
        this.client.on('channelCreate', (channel) => this.handleChannelCreate(channel));
        this.client.on('guildMemberUpdate', (oldMember, newMember) => this.handleGuildMemberUpdate(oldMember, newMember));
        this.client.on('guildUpdate', (oldGuild, newGuild) => this.handleGuildUpdate(oldGuild, newGuild));
        this.client.on('webhookUpdate', (channel) => this.handleWebhookUpdate(channel));
        this.client.on('messageReactionAdd', (reaction, user) => this.handleVoteReaction(reaction, user));

        // Инициализация белого списка (владелец и бот)
        this.initializeWhitelist();

        console.log('✅ Система защиты сервера инициализирована');
    }

    // Инициализация белого списка
    async initializeWhitelist() {
        try {
            // Инициализируем для всех серверов бота
            const guilds = this.client.guilds.cache;
            for (const [guildId, guild] of guilds) {
                // Добавляем владельца в белый список
                if (guild.ownerId) {
                    const owner = await this.client.users.fetch(guild.ownerId).catch(() => null);
                    if (owner) {
                        await store.addToWhitelist(guildId, guild.ownerId, owner.username, true, 'system');
                        console.log(`✅ Владелец ${owner.username} добавлен в белый список защиты для сервера ${guild.name}`);
                    }
                }

                // Добавляем бота в белый список
                if (this.BOT_ID) {
                    const botUser = this.client.user;
                    await store.addToWhitelist(guildId, this.BOT_ID, botUser.username, true, 'system');
                    console.log(`✅ Бот ${botUser.username} добавлен в белый список защиты для сервера ${guild.name}`);
                }
            }
        } catch (err) {
            console.error('Ошибка инициализации белого списка:', err.message);
        }
    }

    // Проверка результатов голосования
    async checkVoteResults(guildId, voteId, actionType, targetMember, executorId, details) {
        try {
            const vote = await store.getVote(guildId, voteId);
            if (!vote || vote.status !== 'pending') return;

            const responses = await store.getVoteResponses(voteId);
            if (responses.length === 0) {
                await store.updateVoteStatus(guildId, voteId, 'rejected', 'no_votes');
                return;
            }

            const approveVotes = responses.filter(r => r.vote === 'approve').length;
            const rejectVotes = responses.filter(r => r.vote === 'reject').length;
            const decision = approveVotes > rejectVotes ? 'approved' : 'rejected';

            await store.updateVoteStatus(guildId, voteId, decision, decision);

            if (decision === 'approved' && targetMember && actionType === 'Снятие мута') {
                await targetMember.timeout(null, 'Одобрено голосованием');
            }

            await this.logAction(guildId, executorId, vote.executor_user_name, 'VOTE_RESULT', actionType, decision, `ЗА: ${approveVotes}, ПРОТИВ: ${rejectVotes}`);
        } catch (err) {
            console.error('Ошибка проверки результатов голосования:', err.message);
        }
    }

    // Обработка реакции на голосование
    async handleVoteReaction(messageReaction, user) {
        try {
            if (user.bot) return;
            const emoji = messageReaction.emoji.name;
            if (emoji !== '✅' && emoji !== '❌') return;

            const content = messageReaction.message.content;
            if (!content.includes('Голосование #')) return;

            const voteIdMatch = content.match(/Голосование #(\w+)/);
            if (!voteIdMatch) return;

            const voteId = voteIdMatch[1];
            const vote = await store.getVote(reaction.message.guildId, voteId);
            if (!vote || vote.status !== 'pending') return;

            const whitelisted = await this.isWhitelisted(reaction.message.guildId, user.id);
            if (!whitelisted) return;

            const voteValue = emoji === '✅' ? 'approve' : 'reject';
            await store.addVoteResponse(voteId, user.id, user.username, voteValue);
            await messageReaction.users.remove(user.id);
        } catch (err) {
            console.error('Ошибка обработки реакции:', err.message);
        }
    }

    // Проверка автоматических наказаний
    async checkAutoPunishments(guildId, executor, violationType) {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) return;

            const member = await guild.members.fetch(executor.id).catch(() => null);
            if (!member) return;

            // Проверяем ограничения для auto_ban
            const autoBanCheck = await this.checkRestriction(guildId, executor.id, RESTRICTION_TYPES.AUTO_BAN);
            if (!autoBanCheck.allowed && autoBanCheck.restriction?.restriction_method === 'block') {
                console.log(`🛡️ 🚫 Автоматический БАН для ${executor.username} за нарушение: ${violationType}`);
                try {
                    await member.ban({ reason: `Автоматический бан за нарушение правил защиты: ${violationType}` });
                    console.log(`🛡️ ✅ Пользователь ${executor.username} забанен автоматически`);
                    await this.logAction(guildId, executor.id, executor.username, 'AUTO_BAN', RESTRICTION_TYPES.AUTO_BAN, 'blocked', `Нарушение: ${violationType}`);
                } catch (banErr) {
                    console.error('🛡️ ❌ Не удалось забанить пользователя:', banErr.message);
                }
                return;
            }

            // Проверяем ограничения для auto_kick
            const autoKickCheck = await this.checkRestriction(guildId, executor.id, RESTRICTION_TYPES.AUTO_KICK);
            if (!autoKickCheck.allowed && autoKickCheck.restriction?.restriction_method === 'block') {
                console.log(`🛡️ 🚫 Автоматический КИК для ${executor.username} за нарушение: ${violationType}`);
                try {
                    await member.kick(`Автоматический кик за нарушение правил защиты: ${violationType}`);
                    console.log(`🛡️ ✅ Пользователь ${executor.username} кикнут автоматически`);
                    await this.logAction(guildId, executor.id, executor.username, 'AUTO_KICK', RESTRICTION_TYPES.AUTO_KICK, 'blocked', `Нарушение: ${violationType}`);
                } catch (kickErr) {
                    console.error('🛡️ ❌ Не удалось кикнуть пользователя:', kickErr.message);
                }
                return;
            }

            // Проверяем ограничения для auto_demote (понижение в правах)
            const autoDemoteCheck = await this.checkRestriction(guildId, executor.id, RESTRICTION_TYPES.AUTO_DEMOTE);
            if (!autoDemoteCheck.allowed && autoDemoteCheck.restriction?.restriction_method === 'block') {
                console.log(`🛡️ 🚫 Автоматическое ПОНИЖЕНИЕ для ${executor.username} за нарушение: ${violationType}`);
                try {
                    // Убираем все роли с правами администратора
                    const adminRoles = member.roles.cache.filter(r => r.permissions.has('Administrator'));
                    if (adminRoles.size > 0) {
                        await member.roles.remove(adminRoles);
                        console.log(`🛡️ ✅ Убрано ${adminRoles.size} админских ролей у ${executor.username}`);
                        await this.logAction(executor.id, executor.username, 'AUTO_DEMOTE', RESTRICTION_TYPES.AUTO_DEMOTE, 'blocked', `Нарушение: ${violationType}, убрано ролей: ${adminRoles.size}`);
                    }
                } catch (demoteErr) {
                    console.error('🛡️ ❌ Не удалось понизить пользователя:', demoteErr.message);
                }
                return;
            }

        } catch (err) {
            console.error('🛡️ ❌ Ошибка при проверке автоматических наказаний:', err.message);
        }
    }
}

module.exports = function(client, sendLog) {
    const securitySystem = new SecuritySystem(client, sendLog);
    securitySystem.initialize();
    return securitySystem;
};
