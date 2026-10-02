const { EmbedBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('./db.js');

// Глобальная переменная для хранения client
let globalClient = null;

// Хранилище активных временных каналов
const tempChannels = new Map(); // channelId -> { ownerId, createdAt, voiceChannelId }

// Создать таблицы для VoiceMaster
async function setupVoiceMasterTables() {
    try {
        // Таблица настроек VoiceMaster
        await db.query(`
            CREATE TABLE IF NOT EXISTS voicemaster_settings (
                guild_id VARCHAR(30) PRIMARY KEY,
                lobby_channel_id VARCHAR(30),
                category_id VARCHAR(30),
                channel_name_template VARCHAR(100) DEFAULT 'Канал {username}',
                default_bitrate INT DEFAULT 64000,
                default_user_limit INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Таблица личных настроек пользователей
        await db.query(`
            CREATE TABLE IF NOT EXISTS voicemaster_user_settings (
                guild_id VARCHAR(30) NOT NULL,
                user_id VARCHAR(30) NOT NULL,
                channel_name VARCHAR(100),
                user_limit INT DEFAULT 0,
                bitrate INT DEFAULT 64000,
                is_locked BOOLEAN DEFAULT false,
                PRIMARY KEY (guild_id, user_id)
            );
        `);

        console.log('✅ Таблицы VoiceMaster созданы');
    } catch (err) {
        console.error('Ошибка создания таблиц VoiceMaster:', err.message);
    }
}

// Получить настройки VoiceMaster
async function getVoiceMasterSettings(guildId) {
    try {
        const result = await db.query(
            'SELECT * FROM voicemaster_settings WHERE guild_id = $1',
            [guildId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('Ошибка получения настроек VoiceMaster:', err.message);
        return null;
    }
}

// Сохранить настройки VoiceMaster
async function saveVoiceMasterSettings(guildId, settings) {
    try {
        await db.query(`
            INSERT INTO voicemaster_settings (guild_id, lobby_channel_id, category_id, channel_name_template, default_bitrate, default_user_limit)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (guild_id)
            DO UPDATE SET lobby_channel_id = $2, category_id = $3, channel_name_template = $4, default_bitrate = $5, default_user_limit = $6
        `,
            [guildId, settings.lobbyChannelId, settings.categoryId, settings.channelNameTemplate, settings.defaultBitrate, settings.defaultUserLimit]
        );
        return true;
    } catch (err) {
        console.error('Ошибка сохранения настроек VoiceMaster:', err.message);
        return false;
    }
}

// Получить настройки пользователя
async function getUserSettings(guildId, userId) {
    try {
        const result = await db.query(
            'SELECT * FROM voicemaster_user_settings WHERE guild_id = $1 AND user_id = $2',
            [guildId, userId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('Ошибка получения настроек пользователя:', err.message);
        return null;
    }
}

// Сохранить настройки пользователя
async function saveUserSettings(guildId, userId, settings) {
    try {
        await db.query(`
            INSERT INTO voicemaster_user_settings (guild_id, user_id, channel_name, user_limit, bitrate, is_locked)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (guild_id, user_id)
            DO UPDATE SET channel_name = $3, user_limit = $4, bitrate = $5, is_locked = $6
        `,
            [guildId, userId, settings.channelName, settings.userLimit, settings.bitrate, settings.isLocked]
        );
        return true;
    } catch (err) {
        console.error('Ошибка сохранения настроек пользователя:', err.message);
        return false;
    }
}

// Создать личный голосовой канал
async function createPersonalChannel(member, settings) {
    try {
        const guild = member.guild;
        const userSettings = await getUserSettings(guild.id, member.id);
        
        // Определяем имя канала
        let channelName = settings.channelNameTemplate || 'Канал {username}';
        channelName = channelName.replace('{username}', member.user.username);
        
        if (userSettings && userSettings.channel_name) {
            channelName = userSettings.channel_name;
        }

        // Определяем лимит пользователей
        let userLimit = settings.defaultUserLimit || 0;
        if (userSettings && userSettings.user_limit !== null) {
            userLimit = userSettings.user_limit;
        }

        // Определяем битрейт
        let bitrate = settings.defaultBitrate || 64000;
        if (userSettings && userSettings.bitrate) {
            bitrate = userSettings.bitrate;
        }

        // Создаём голосовой канал
        const channelOptions = {
            name: channelName,
            type: ChannelType.GuildVoice,
            bitrate: bitrate,
            userLimit: userLimit,
            parent: settings.categoryId || null,
            permissionOverwrites: [
                {
                    id: member.id,
                    allow: [
                        PermissionFlagsBits.Connect,
                        PermissionFlagsBits.Speak,
                        PermissionFlagsBits.Stream,
                        PermissionFlagsBits.UseVAD,
                        PermissionFlagsBits.PrioritySpeaker,
                        PermissionFlagsBits.ManageChannels
                    ]
                }
            ]
        };

        // Если канал заблокирован, запрещаем подключение другим
        if (userSettings && userSettings.is_locked) {
            channelOptions.permissionOverwrites.push({
                id: guild.roles.everyone,
                deny: [PermissionFlagsBits.Connect]
            });
        }

        // Создаём голосовой канал
        const voiceChannel = await guild.channels.create(channelOptions);
        console.log(`✅ VoiceMaster: Создан голосовой канал "${voiceChannel.name}" для ${member.user.username}`);

        // Сохраняем информацию о канале с пометкой что это VoiceMaster канал
        tempChannels.set(voiceChannel.id, {
            ownerId: member.id,
            createdAt: Date.now(),
            voiceChannelId: voiceChannel.id,
            isVoiceMaster: true
        });

        return { success: true, channel: voiceChannel };
    } catch (err) {
        console.error('❌ VoiceMaster: Ошибка создания канала:', err.message);
        return { success: false, error: err.message };
    }
}

// Удалить личный канал
async function deletePersonalChannel(channelId) {
    try {
        const channelData = tempChannels.get(channelId);
        if (!channelData) return false;

        const voiceChannel = await globalClient.channels.fetch(channelId).catch(() => null);
        if (!voiceChannel) return false;

        const guild = voiceChannel.guild;
        if (!guild) return false;

        // Удаляем только голосовой канал (Discord сам удалит связанный текстовый)
        await voiceChannel.delete('Автоматическое удаление пустого канала');

        tempChannels.delete(channelId);
        return true;
    } catch (err) {
        console.error('Ошибка удаления личного канала:', err.message);
        return false;
    }
}

// Показать панель управления личным каналом
async function showControlPanel(interaction) {
    const userSettings = await getUserSettings(interaction.guildId, interaction.user.id);
    
    const embed = new EmbedBuilder()
        .setColor('#8b5cf6')
        .setTitle('🎙️ Управление личным каналом')
        .setDescription('Настройте ваш личный голосовой канал')
        .addFields(
            { name: '📝 Название', value: userSettings?.channel_name || 'По умолчанию', inline: true },
            { name: '👥 Лимит', value: userSettings?.user_limit ? userSettings.user_limit.toString() : 'Безлимит', inline: true },
            { name: '🔒 Статус', value: userSettings?.is_locked ? '🔒 Закрыт' : '🔓 Открыт', inline: true }
        )
        .setTimestamp();

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('vm_control_select')
        .setPlaceholder('Выберите действие')
        .addOptions(
            { label: '📝 Переименовать', value: 'rename', description: 'Изменить название канала' },
            { label: '👥 Лимит', value: 'limit', description: 'Установить лимит пользователей' },
            { label: userSettings?.is_locked ? '🔓 Открыть' : '🔒 Закрыть', value: 'lock', description: userSettings?.is_locked ? 'Открыть доступ к каналу' : 'Закрыть доступ к каналу' },
            { label: '📊 Битрейт', value: 'bitrate', description: 'Изменить качество звука' },
            { label: '🚫 Отклонить', value: 'reject', description: 'Заблокировать доступ пользователя/роли' },
            { label: '✅ Пригласить', value: 'invite', description: 'Пригласить пользователя в канал' },
            { label: '👻 Скрыть', value: 'ghost', description: 'Сделать канал невидимым' },
            { label: '👁️ Показать', value: 'unghost', description: 'Сделать канал видимым' },
            { label: '🔄 Передать', value: 'transfer', description: 'Передать владение каналом' }
        );

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// Автоматическая отправка панели управления при создании канала
async function sendAutoControlPanel(member, voiceChannel) {
    try {
        const userSettings = await getUserSettings(member.guild.id, member.id);
        
        const embed = new EmbedBuilder()
            .setColor('#8b5cf6')
            .setTitle('🎙️ Добро пожаловать на канал ' + voiceChannel.name + '!')
            .setDescription('Настройте ваш личный голосовой канал')
            .addFields(
                { name: '📝 Название', value: userSettings?.channel_name || 'По умолчанию', inline: true },
                { name: '👥 Лимит', value: userSettings?.user_limit ? userSettings.user_limit.toString() : 'Безлимит', inline: true },
                { name: '🔒 Статус', value: userSettings?.is_locked ? '🔒 Закрыт' : '🔓 Открыт', inline: true }
            )
            .setTimestamp();

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('vm_control_select')
            .setPlaceholder('Выберите действие')
            .addOptions(
                { label: '📝 Переименовать', value: 'rename', description: 'Изменить название канала' },
                { label: '👥 Лимит', value: 'limit', description: 'Установить лимит пользователей' },
                { label: userSettings?.is_locked ? '🔓 Открыть' : '🔒 Закрыть', value: 'lock', description: userSettings?.is_locked ? 'Открыть доступ к каналу' : 'Закрыть доступ к каналу' },
                { label: '📊 Битрейт', value: 'bitrate', description: 'Изменить качество звука' },
                { label: '🚫 Отклонить', value: 'reject', description: 'Заблокировать доступ пользователя/роли' },
                { label: '✅ Пригласить', value: 'invite', description: 'Пригласить пользователя в канал' },
                { label: '👻 Скрыть', value: 'ghost', description: 'Сделать канал невидимым' },
                { label: '👁️ Показать', value: 'unghost', description: 'Сделать канал видимым' },
                { label: '🔄 Передать', value: 'transfer', description: 'Передать владение каналом' }
            );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        // В Community Server Discord использует тот же ID для текстового и голосового канала
        // Пробуем отправить сообщение используя ID голосового канала как текстового
        try {
            const textChannel = await member.guild.channels.fetch(voiceChannel.id);
            if (textChannel && textChannel.isTextBased()) {
                await textChannel.send({ 
                    content: `<@${member.id}>`, 
                    embeds: [embed], 
                    components: [row] 
                });
                console.log(`✅ Панель управления отправлена в текстовый канал (ID: ${voiceChannel.id})`);
                return;
            }
        } catch (err) {
            console.log(`⚠️ Не удалось использовать ID голосового канала: ${err.message}`);
        }
        
        console.log(`⚠️ Текстовый канал не найден для ${voiceChannel.name}`);
    } catch (err) {
        console.error('❌ Ошибка отправки панели управления:', err.message);
    }
}

// Регистрация slash-команд
async function registerCommands(client) {
    try {
        // Команда настройки VoiceMaster (для админов)
        const setupCommand = {
            name: 'vm_setup',
            description: 'Настроить систему VoiceMaster',
            defaultMemberPermissions: [PermissionFlagsBits.ManageChannels],
            options: [
                {
                    name: 'lobby',
                    description: 'Lobby канал для создания личных каналов',
                    type: 7, // CHANNEL
                    channelTypes: [ChannelType.GuildVoice],
                    required: true
                },
                {
                    name: 'category',
                    description: 'Категория для личных каналов',
                    type: 7, // CHANNEL
                    channelTypes: [ChannelType.GuildCategory],
                    required: false
                }
            ]
        };

        // Команда управления личным каналом
        const controlCommand = {
            name: 'vm',
            description: 'Управление личным голосовым каналом'
        };

        // Регистрируем команды глобально
        await client.application.commands.set([setupCommand, controlCommand]);

        console.log('✅ Команды VoiceMaster зарегистрированы глобально');
    } catch (err) {
        console.error('Ошибка регистрации команд VoiceMaster:', err.message);
    }
}

// Основной модуль
module.exports = function(client) {
    // Сохраняем client глобально для использования в функциях
    globalClient = client;
    
    // Создаём таблицы при запуске
    setupVoiceMasterTables();

    // Регистрируем команды при готовности бота
    client.once('ready', () => {
        registerCommands(client);
    });

    // Обработчик захода в голосовой канал
    client.on('voiceStateUpdate', async (oldState, newState) => {
        const guildId = newState.guild.id;

        const settings = await getVoiceMasterSettings(guildId);
        if (!settings || !settings.lobby_channel_id) return;

        // Пользователь заходит в lobby канал
        if (newState.channelId === settings.lobby_channel_id && oldState.channelId !== settings.lobby_channel_id) {
            const member = newState.member;
            if (!member || member.user.bot) return;

            console.log(`🎙️ Пользователь ${member.user.username} зашёл в lobby, создаю личный канал`);

            // Создаём личный канал
            const result = await createPersonalChannel(member, settings);

            if (result.success) {
                console.log(`✅ Личный канал создан: ${result.channel.name}`);

                // Перемещаем пользователя в новый канал
                try {
                    await member.voice.setChannel(result.channel);
                    console.log(`✅ Пользователь ${member.user.username} перемещён в личный канал`);

                    // Отправляем панель управления автоматически
                    await sendAutoControlPanel(member, result.channel);
                } catch (err) {
                    console.error('❌ Ошибка перемещения пользователя:', err.message);
                }
            } else {
                console.error(`❌ Ошибка создания личного канала: ${result.error}`);
            }
        }

        // Пользователь покидает личный канал
        if (oldState.channelId && tempChannels.has(oldState.channelId)) {
            const channelData = tempChannels.get(oldState.channelId);
            const channel = await client.channels.fetch(oldState.channelId).catch(() => null);

            if (channel && channel.members.size === 0) {
                console.log(`🗑️ Личный канал ${channel.name} пуст, удаляю сразу`);
                await deletePersonalChannel(oldState.channelId);
            }
        }
    });

    // Обработчик slash-команды /vm_setup
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== 'vm_setup') return;

        const lobbyChannel = interaction.options.getChannel('lobby');
        const categoryChannel = interaction.options.getChannel('category');

        await saveVoiceMasterSettings(interaction.guildId, {
            lobbyChannelId: lobbyChannel.id,
            categoryId: categoryChannel?.id || null,
            channelNameTemplate: 'Канал {username}',
            defaultBitrate: 64000,
            defaultUserLimit: 0
        });

        const embed = new EmbedBuilder()
            .setColor('#22c55e')
            .setTitle('✅ VoiceMaster настроен')
            .addFields(
                { name: '🎙️ Lobby канал', value: `<#${lobbyChannel.id}>`, inline: true },
                { name: '📁 Категория', value: categoryChannel ? `<#${categoryChannel.id}>` : 'Не указана', inline: true }
            )
            .setDescription('Теперь пользователи могут создавать личные каналы заходя в lobby!')
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    });

    // Обработчик slash-команды /vm
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== 'vm') return;

        await showControlPanel(interaction);
    });

    // Обработчик select menu панели управления
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isStringSelectMenu()) return;
        if (interaction.customId !== 'vm_control_select') return;

        const action = interaction.values[0];
        const userSettings = await getUserSettings(interaction.guildId, interaction.user.id) || {};

        switch (action) {
            case 'rename':
                const renameModal = new ModalBuilder()
                    .setCustomId('vm_rename_modal')
                    .setTitle('Переименовать канал');
                const channelNameInput = new TextInputBuilder()
                    .setCustomId('channel_name')
                    .setLabel('Новое название канала')
                    .setPlaceholder('Введите название...')
                    .setStyle(TextInputStyle.Short)
                    .setMaxLength(100)
                    .setValue(userSettings?.channel_name || '');
                const renameRow = new ActionRowBuilder().addComponents(channelNameInput);
                renameModal.addComponents(renameRow);
                await interaction.showModal(renameModal);
                break;
            case 'limit':
                const limitModal = new ModalBuilder()
                    .setCustomId('vm_limit_modal')
                    .setTitle('Установить лимит пользователей');
                const limitInput = new TextInputBuilder()
                    .setCustomId('user_limit')
                    .setLabel('Лимит пользователей (0 = безлимит)')
                    .setPlaceholder('Введите число от 0 до 99')
                    .setStyle(TextInputStyle.Short)
                    .setMaxLength(2)
                    .setValue(userSettings?.user_limit ? userSettings.user_limit.toString() : '0');
                const limitRow2 = new ActionRowBuilder().addComponents(limitInput);
                limitModal.addComponents(limitRow2);
                await interaction.showModal(limitModal);
                break;
            case 'lock':
                const newLockState = !userSettings.is_locked;
                await saveUserSettings(interaction.guildId, interaction.user.id, { ...userSettings, is_locked: newLockState });
                const voiceChannel = interaction.member.voice.channel;
                if (voiceChannel && tempChannels.has(voiceChannel.id)) {
                    if (newLockState) {
                        await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
                    } else {
                        await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: true });
                    }
                }
                const updatedSettings = await getUserSettings(interaction.guildId, interaction.user.id);
                const lockEmbed = new EmbedBuilder()
                    .setColor('#8b5cf6')
                    .setTitle('🎙️ Управление личным каналом')
                    .setDescription('Настройте ваш личный голосовой канал')
                    .addFields(
                        { name: '📝 Название', value: updatedSettings?.channel_name || 'По умолчанию', inline: true },
                        { name: '👥 Лимит', value: updatedSettings?.user_limit ? updatedSettings.user_limit.toString() : 'Безлимит', inline: true },
                        { name: '🔒 Статус', value: updatedSettings?.is_locked ? '🔒 Закрыт' : '🔓 Открыт', inline: true }
                    )
                    .setTimestamp();
                const lockSelectMenu = new StringSelectMenuBuilder()
                    .setCustomId('vm_control_select')
                    .setPlaceholder('Выберите действие')
                    .addOptions(
                        { label: '📝 Переименовать', value: 'rename', description: 'Изменить название канала' },
                        { label: '👥 Лимит', value: 'limit', description: 'Установить лимит пользователей' },
                        { label: updatedSettings?.is_locked ? '� Открыть' : '�🔒 Закрыть', value: 'lock', description: updatedSettings?.is_locked ? 'Открыть доступ к каналу' : 'Закрыть доступ к каналу' },
                        { label: '� Битрейт', value: 'bitrate', description: 'Изменить качество звука' },
                        { label: '🚫 Отклонить', value: 'reject', description: 'Заблокировать доступ пользователя/роли' },
                        { label: '✅ Пригласить', value: 'invite', description: 'Пригласить пользователя в канал' },
                        { label: '👻 Скрыть', value: 'ghost', description: 'Сделать канал невидимым' },
                        { label: '👁️ Показать', value: 'unghost', description: 'Сделать канал видимым' },
                        { label: '🔄 Передать', value: 'transfer', description: 'Передать владение каналом' }
                    );
                const lockRow = new ActionRowBuilder().addComponents(lockSelectMenu);
                await interaction.update({ embeds: [lockEmbed], components: [lockRow] });
                break;
            case 'bitrate':
                const bitrateSelect = new StringSelectMenuBuilder()
                    .setCustomId('vm_bitrate_select')
                    .setPlaceholder('Выберите битрейт')
                    .addOptions(
                        { label: '8 kbps (минимальный)', value: '8000', description: 'Для медленного интернета' },
                        { label: '16 kbps', value: '16000', description: 'Низкое качество' },
                        { label: '32 kbps', value: '32000', description: 'Среднее качество' },
                        { label: '64 kbps (стандарт)', value: '64000', description: 'По умолчанию' },
                        { label: '96 kbps', value: '96000', description: 'Высокое качество' },
                        { label: '128 kbps', value: '128000', description: 'Очень высокое качество' },
                        { label: '256 kbps (макс)', value: '256000', description: 'Для Nitro серверов' },
                        { label: '384 kbps (ультра)', value: '384000', description: 'Только для Boost Level 3' }
                    );
                const bitrateRow = new ActionRowBuilder().addComponents(bitrateSelect);
                await interaction.update({ content: 'Выберите битрейт:', embeds: [], components: [bitrateRow] });
                break;
            case 'reject':
                await showRejectModal(interaction);
                break;
            case 'invite':
                await showInviteModal(interaction);
                break;
            case 'ghost':
                await toggleGhostMode(interaction, true);
                break;
            case 'unghost':
                await toggleGhostMode(interaction, false);
                break;
            case 'transfer':
                await showTransferModal(interaction);
                break;
        }
    });

    // Обработчик модальных окон
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isModalSubmit()) return;

        if (interaction.customId === 'vm_rename_modal') {
            const newName = interaction.fields.getTextInputValue('channel_name').trim();
            if (!newName) {
                await interaction.reply({ content: '❌ Название не может быть пустым', ephemeral: true });
                return;
            }

            const currentSettings = await getUserSettings(interaction.guildId, interaction.user.id) || {};
            await saveUserSettings(interaction.guildId, interaction.user.id, {
                ...currentSettings,
                channelName: newName
            });

            const voiceChannel = interaction.member.voice.channel;
            if (voiceChannel && tempChannels.has(voiceChannel.id)) {
                await voiceChannel.setName(newName);
            }

            const updatedSettings = await getUserSettings(interaction.guildId, interaction.user.id);
            const renameEmbed = new EmbedBuilder()
                .setColor('#8b5cf6')
                .setTitle('🎙️ Управление личным каналом')
                .setDescription('Настройте ваш личный голосовой канал')
                .addFields(
                    { name: '📝 Название', value: updatedSettings?.channel_name || 'По умолчанию', inline: true },
                    { name: '👥 Лимит', value: updatedSettings?.user_limit ? updatedSettings.user_limit.toString() : 'Безлимит', inline: true },
                    { name: '🔒 Статус', value: updatedSettings?.is_locked ? '🔒 Закрыт' : '🔓 Открыт', inline: true }
                )
                .setTimestamp();
            const renameSelectMenu = new StringSelectMenuBuilder()
                .setCustomId('vm_control_select')
                .setPlaceholder('Выберите действие')
                .addOptions(
                    { label: '📝 Переименовать', value: 'rename', description: 'Изменить название канала' },
                    { label: '👥 Лимит', value: 'limit', description: 'Установить лимит пользователей' },
                    { label: updatedSettings?.is_locked ? '🔓 Открыть' : '🔒 Закрыть', value: 'lock', description: updatedSettings?.is_locked ? 'Открыть доступ к каналу' : 'Закрыть доступ к каналу' },
                    { label: '📊 Битрейт', value: 'bitrate', description: 'Изменить качество звука' },
                    { label: '🚫 Отклонить', value: 'reject', description: 'Заблокировать доступ пользователя/роли' },
                    { label: '✅ Пригласить', value: 'invite', description: 'Пригласить пользователя в канал' },
                    { label: '👻 Скрыть', value: 'ghost', description: 'Сделать канал невидимым' },
                    { label: '👁️ Показать', value: 'unghost', description: 'Сделать канал видимым' },
                    { label: '🔄 Передать', value: 'transfer', description: 'Передать владение каналом' }
                );
            const renameRow = new ActionRowBuilder().addComponents(renameSelectMenu);
            await interaction.update({ content: `✅ Название изменено на "${newName}"`, embeds: [renameEmbed], components: [renameRow] });
        }

        if (interaction.customId === 'vm_limit_modal') {
            const limitStr = interaction.fields.getTextInputValue('user_limit').trim();
            const limit = parseInt(limitStr, 10);

            if (isNaN(limit) || limit < 0 || limit > 99) {
                await interaction.reply({ content: '❌ Лимит должен быть числом от 0 до 99', ephemeral: true });
                return;
            }

            await saveUserSettings(interaction.guildId, interaction.user.id, {
                ...(await getUserSettings(interaction.guildId, interaction.user.id) || {}),
                user_limit: limit
            });

            const voiceChannel = interaction.member.voice.channel;
            if (voiceChannel && tempChannels.has(voiceChannel.id)) {
                await voiceChannel.setUserLimit(limit);
            }

            const updatedSettings = await getUserSettings(interaction.guildId, interaction.user.id);
            const limitEmbed = new EmbedBuilder()
                .setColor('#8b5cf6')
                .setTitle('🎙️ Управление личным каналом')
                .setDescription('Настройте ваш личный голосовой канал')
                .addFields(
                    { name: '📝 Название', value: updatedSettings?.channel_name || 'По умолчанию', inline: true },
                    { name: '👥 Лимит', value: updatedSettings?.user_limit ? updatedSettings.user_limit.toString() : 'Безлимит', inline: true },
                    { name: '🔒 Статус', value: updatedSettings?.is_locked ? '🔒 Закрыт' : '🔓 Открыт', inline: true }
                )
                .setTimestamp();
            const limitSelectMenu = new StringSelectMenuBuilder()
                .setCustomId('vm_control_select')
                .setPlaceholder('Выберите действие')
                .addOptions(
                    { label: '📝 Переименовать', value: 'rename', description: 'Изменить название канала' },
                    { label: '👥 Лимит', value: 'limit', description: 'Установить лимит пользователей' },
                    { label: updatedSettings?.is_locked ? '🔓 Открыть' : '🔒 Закрыть', value: 'lock', description: updatedSettings?.is_locked ? 'Открыть доступ к каналу' : 'Закрыть доступ к каналу' },
                    { label: '📊 Битрейт', value: 'bitrate', description: 'Изменить качество звука' },
                    { label: '🚫 Отклонить', value: 'reject', description: 'Заблокировать доступ пользователя/роли' },
                    { label: '✅ Пригласить', value: 'invite', description: 'Пригласить пользователя в канал' },
                    { label: '👻 Скрыть', value: 'ghost', description: 'Сделать канал невидимым' },
                    { label: '👁️ Показать', value: 'unghost', description: 'Сделать канал видимым' },
                    { label: '🔄 Передать', value: 'transfer', description: 'Передать владение каналом' }
                );
            const limitRow = new ActionRowBuilder().addComponents(limitSelectMenu);
            await interaction.update({ content: `✅ Лимит установлен: ${limit === 0 ? 'Безлимит' : limit + ' человек'}`, embeds: [limitEmbed], components: [limitRow] });
        }

        if (interaction.customId === 'vm_reject_modal') {
            const targetId = interaction.fields.getTextInputValue('target_id').trim();
            const targetRole = interaction.fields.getTextInputValue('target_role').trim();

            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.reply({ content: '❌ Вы не в голосовом канале', ephemeral: true });
                return;
            }

            if (!tempChannels.has(voiceChannel.id)) {
                await interaction.reply({ content: '❌ Это не ваш личный канал', ephemeral: true });
                return;
            }

            const channelData = tempChannels.get(voiceChannel.id);
            if (channelData.ownerId !== interaction.user.id) {
                await interaction.reply({ content: '❌ Вы не владелец этого канала', ephemeral: true });
                return;
            }

            let successMessage = '';
            if (targetId) {
                await voiceChannel.permissionOverwrites.edit(targetId, { Connect: false });
                successMessage = `✅ Пользователь <@${targetId}> заблокирован`;
            } else if (targetRole) {
                await voiceChannel.permissionOverwrites.edit(targetRole, { Connect: false });
                successMessage = `✅ Роль <@&${targetRole}> заблокирована`;
            } else {
                await interaction.reply({ content: '❌ Укажите ID пользователя или роль', ephemeral: true });
                return;
            }

            const updatedSettings = await getUserSettings(interaction.guildId, interaction.user.id);
            const rejectEmbed = new EmbedBuilder()
                .setColor('#8b5cf6')
                .setTitle('🎙️ Управление личным каналом')
                .setDescription('Настройте ваш личный голосовой канал')
                .addFields(
                    { name: '📝 Название', value: updatedSettings?.channel_name || 'По умолчанию', inline: true },
                    { name: '👥 Лимит', value: updatedSettings?.user_limit ? updatedSettings.user_limit.toString() : 'Безлимит', inline: true },
                    { name: '🔒 Статус', value: updatedSettings?.is_locked ? '🔒 Закрыт' : '🔓 Открыт', inline: true }
                )
                .setTimestamp();
            const rejectSelectMenu = new StringSelectMenuBuilder()
                .setCustomId('vm_control_select')
                .setPlaceholder('Выберите действие')
                .addOptions(
                    { label: '📝 Переименовать', value: 'rename', description: 'Изменить название канала' },
                    { label: '👥 Лимит', value: 'limit', description: 'Установить лимит пользователей' },
                    { label: updatedSettings?.is_locked ? '🔓 Открыть' : '🔒 Закрыть', value: 'lock', description: updatedSettings?.is_locked ? 'Открыть доступ к каналу' : 'Закрыть доступ к каналу' },
                    { label: '📊 Битрейт', value: 'bitrate', description: 'Изменить качество звука' },
                    { label: '🚫 Отклонить', value: 'reject', description: 'Заблокировать доступ пользователя/роли' },
                    { label: '✅ Пригласить', value: 'invite', description: 'Пригласить пользователя в канал' },
                    { label: '👻 Скрыть', value: 'ghost', description: 'Сделать канал невидимым' },
                    { label: '👁️ Показать', value: 'unghost', description: 'Сделать канал видимым' },
                    { label: '🔄 Передать', value: 'transfer', description: 'Передать владение каналом' }
                );
            const rejectRow = new ActionRowBuilder().addComponents(rejectSelectMenu);
            await interaction.update({ content: successMessage, embeds: [rejectEmbed], components: [rejectRow] });
        }

        if (interaction.customId === 'vm_invite_modal') {
            const targetId = interaction.fields.getTextInputValue('target_id').trim();

            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.reply({ content: '❌ Вы не в голосовом канале', ephemeral: true });
                return;
            }

            if (!tempChannels.has(voiceChannel.id)) {
                await interaction.reply({ content: '❌ Это не ваш личный канал', ephemeral: true });
                return;
            }

            const channelData = tempChannels.get(voiceChannel.id);
            if (channelData.ownerId !== interaction.user.id) {
                await interaction.reply({ content: '❌ Вы не владелец этого канала', ephemeral: true });
                return;
            }

            await voiceChannel.permissionOverwrites.edit(targetId, { Connect: true });

            const updatedSettings = await getUserSettings(interaction.guildId, interaction.user.id);
            const inviteEmbed = new EmbedBuilder()
                .setColor('#8b5cf6')
                .setTitle('🎙️ Управление личным каналом')
                .setDescription('Настройте ваш личный голосовой канал')
                .addFields(
                    { name: '📝 Название', value: updatedSettings?.channel_name || 'По умолчанию', inline: true },
                    { name: '👥 Лимит', value: updatedSettings?.user_limit ? updatedSettings.user_limit.toString() : 'Безлимит', inline: true },
                    { name: '🔒 Статус', value: updatedSettings?.is_locked ? '🔒 Закрыт' : '🔓 Открыт', inline: true }
                )
                .setTimestamp();
            const inviteSelectMenu = new StringSelectMenuBuilder()
                .setCustomId('vm_control_select')
                .setPlaceholder('Выберите действие')
                .addOptions(
                    { label: '📝 Переименовать', value: 'rename', description: 'Изменить название канала' },
                    { label: '👥 Лимит', value: 'limit', description: 'Установить лимит пользователей' },
                    { label: updatedSettings?.is_locked ? '🔓 Открыть' : '🔒 Закрыть', value: 'lock', description: updatedSettings?.is_locked ? 'Открыть доступ к каналу' : 'Закрыть доступ к каналу' },
                    { label: '📊 Битрейт', value: 'bitrate', description: 'Изменить качество звука' },
                    { label: '🚫 Отклонить', value: 'reject', description: 'Заблокировать доступ пользователя/роли' },
                    { label: '✅ Пригласить', value: 'invite', description: 'Пригласить пользователя в канал' },
                    { label: '👻 Скрыть', value: 'ghost', description: 'Сделать канал невидимым' },
                    { label: '👁️ Показать', value: 'unghost', description: 'Сделать канал видимым' },
                    { label: '🔄 Передать', value: 'transfer', description: 'Передать владение каналом' }
                );
            const inviteRow = new ActionRowBuilder().addComponents(inviteSelectMenu);
            await interaction.update({ content: `✅ Пользователь <@${targetId}> приглашён`, embeds: [inviteEmbed], components: [inviteRow] });
        }

        if (interaction.customId === 'vm_transfer_modal') {
            const targetId = interaction.fields.getTextInputValue('target_id').trim();

            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.reply({ content: '❌ Вы не в голосовом канале', ephemeral: true });
                return;
            }

            if (!tempChannels.has(voiceChannel.id)) {
                await interaction.reply({ content: '❌ Это не ваш личный канал', ephemeral: true });
                return;
            }

            const channelData = tempChannels.get(voiceChannel.id);
            if (channelData.ownerId !== interaction.user.id) {
                await interaction.reply({ content: '❌ Вы не владелец этого канала', ephemeral: true });
                return;
            }

            await voiceChannel.permissionOverwrites.edit(interaction.user.id, { ManageChannels: null });
            await voiceChannel.permissionOverwrites.edit(targetId, {
                Connect: true,
                Speak: true,
                Stream: true,
                UseVAD: true,
                PrioritySpeaker: true,
                ManageChannels: true
            });

            channelData.ownerId = targetId;
            tempChannels.set(voiceChannel.id, channelData);

            const updatedSettings = await getUserSettings(interaction.guildId, interaction.user.id);
            const transferEmbed = new EmbedBuilder()
                .setColor('#8b5cf6')
                .setTitle('🎙️ Управление личным каналом')
                .setDescription('Настройте ваш личный голосовой канал')
                .addFields(
                    { name: '📝 Название', value: updatedSettings?.channel_name || 'По умолчанию', inline: true },
                    { name: '👥 Лимит', value: updatedSettings?.user_limit ? updatedSettings.user_limit.toString() : 'Безлимит', inline: true },
                    { name: '🔒 Статус', value: updatedSettings?.is_locked ? '🔒 Закрыт' : '🔓 Открыт', inline: true }
                )
                .setTimestamp();
            const transferSelectMenu = new StringSelectMenuBuilder()
                .setCustomId('vm_control_select')
                .setPlaceholder('Выберите действие')
                .addOptions(
                    { label: '📝 Переименовать', value: 'rename', description: 'Изменить название канала' },
                    { label: '👥 Лимит', value: 'limit', description: 'Установить лимит пользователей' },
                    { label: updatedSettings?.is_locked ? '🔓 Открыть' : '🔒 Закрыть', value: 'lock', description: updatedSettings?.is_locked ? 'Открыть доступ к каналу' : 'Закрыть доступ к каналу' },
                    { label: '📊 Битрейт', value: 'bitrate', description: 'Изменить качество звука' },
                    { label: '🚫 Отклонить', value: 'reject', description: 'Заблокировать доступ пользователя/роли' },
                    { label: '✅ Пригласить', value: 'invite', description: 'Пригласить пользователя в канал' },
                    { label: '👻 Скрыть', value: 'ghost', description: 'Сделать канал невидимым' },
                    { label: '👁️ Показать', value: 'unghost', description: 'Сделать канал видимым' },
                    { label: '🔄 Передать', value: 'transfer', description: 'Передать владение каналом' }
                );
            const transferRow = new ActionRowBuilder().addComponents(transferSelectMenu);
            await interaction.update({ content: `✅ Владение каналом передано <@${targetId}>`, embeds: [transferEmbed], components: [transferRow] });
        }
    });

    // Обработчик выбора битрейта
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isStringSelectMenu()) return;
        if (interaction.customId !== 'vm_bitrate_select') return;

        const bitrate = parseInt(interaction.values[0], 10);

        await saveUserSettings(interaction.guildId, interaction.user.id, {
            ...(await getUserSettings(interaction.guildId, interaction.user.id) || {}),
            bitrate: bitrate
        });

        const voiceChannel = interaction.member.voice.channel;
        if (voiceChannel && tempChannels.has(voiceChannel.id)) {
            await voiceChannel.setBitrate(bitrate);
        }

        const updatedSettings = await getUserSettings(interaction.guildId, interaction.user.id);
        const bitrateEmbed = new EmbedBuilder()
            .setColor('#8b5cf6')
            .setTitle('🎙️ Управление личным каналом')
            .setDescription('Настройте ваш личный голосовой канал')
            .addFields(
                { name: '📝 Название', value: updatedSettings?.channel_name || 'По умолчанию', inline: true },
                { name: '👥 Лимит', value: updatedSettings?.user_limit ? updatedSettings.user_limit.toString() : 'Безлимит', inline: true },
                { name: '🔒 Статус', value: updatedSettings?.is_locked ? '🔒 Закрыт' : '🔓 Открыт', inline: true }
            )
            .setTimestamp();
        const bitrateSelectMenu = new StringSelectMenuBuilder()
            .setCustomId('vm_control_select')
            .setPlaceholder('Выберите действие')
            .addOptions(
                { label: '📝 Переименовать', value: 'rename', description: 'Изменить название канала' },
                { label: '👥 Лимит', value: 'limit', description: 'Установить лимит пользователей' },
                { label: updatedSettings?.is_locked ? '🔓 Открыть' : '🔒 Закрыть', value: 'lock', description: updatedSettings?.is_locked ? 'Открыть доступ к каналу' : 'Закрыть доступ к каналу' },
                { label: '📊 Битрейт', value: 'bitrate', description: 'Изменить качество звука' },
                { label: '🚫 Отклонить', value: 'reject', description: 'Заблокировать доступ пользователя/роли' },
                { label: '✅ Пригласить', value: 'invite', description: 'Пригласить пользователя в канал' },
                { label: '👻 Скрыть', value: 'ghost', description: 'Сделать канал невидимым' },
                { label: '👁️ Показать', value: 'unghost', description: 'Сделать канал видимым' },
                { label: '🔄 Передать', value: 'transfer', description: 'Передать владение каналом' }
            );
        const bitrateRow = new ActionRowBuilder().addComponents(bitrateSelectMenu);
        await interaction.update({ content: `✅ Битрейт установлен: ${bitrate / 1000} kbps`, embeds: [bitrateEmbed], components: [bitrateRow] });
    });

    // Функция показа модального окна для Reject
    async function showRejectModal(interaction) {
        const rejectModal = new ModalBuilder()
            .setCustomId('vm_reject_modal')
            .setTitle('Заблокировать доступ');

        const userIdInput = new TextInputBuilder()
            .setCustomId('target_id')
            .setLabel('ID пользователя (оставьте пустым если блокируете роль)')
            .setPlaceholder('Discord ID пользователя')
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

        const roleIdInput = new TextInputBuilder()
            .setCustomId('target_role')
            .setLabel('ID роли (оставьте пустым если блокируете пользователя)')
            .setPlaceholder('Discord ID роли')
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

        const row1 = new ActionRowBuilder().addComponents(userIdInput);
        const row2 = new ActionRowBuilder().addComponents(roleIdInput);

        rejectModal.addComponents(row1, row2);
        await interaction.showModal(rejectModal);
    }

    // Функция показа модального окна для Invite
    async function showInviteModal(interaction) {
        const inviteModal = new ModalBuilder()
            .setCustomId('vm_invite_modal')
            .setTitle('Пригласить пользователя');

        const userIdInput = new TextInputBuilder()
            .setCustomId('target_id')
            .setLabel('ID пользователя')
            .setPlaceholder('Discord ID пользователя')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const row = new ActionRowBuilder().addComponents(userIdInput);
        inviteModal.addComponents(row);
        await interaction.showModal(inviteModal);
    }

    // Функция переключения режима Ghost
    async function toggleGhostMode(interaction, ghost) {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            await interaction.reply({ content: '❌ Вы не в голосовом канале', ephemeral: true });
            return;
        }

        if (!tempChannels.has(voiceChannel.id)) {
            await interaction.reply({ content: '❌ Это не ваш личный канал', ephemeral: true });
            return;
        }

        const channelData = tempChannels.get(voiceChannel.id);
        if (channelData.ownerId !== interaction.user.id) {
            await interaction.reply({ content: '❌ Вы не владелец этого канала', ephemeral: true });
            return;
        }

        if (ghost) {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false });
        } else {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: true });
        }

        const updatedSettings = await getUserSettings(interaction.guildId, interaction.user.id);
        const ghostEmbed = new EmbedBuilder()
            .setColor('#8b5cf6')
            .setTitle('🎙️ Управление личным каналом')
            .setDescription('Настройте ваш личный голосовой канал')
            .addFields(
                { name: '📝 Название', value: updatedSettings?.channel_name || 'По умолчанию', inline: true },
                { name: '👥 Лимит', value: updatedSettings?.user_limit ? updatedSettings.user_limit.toString() : 'Безлимит', inline: true },
                { name: '🔒 Статус', value: updatedSettings?.is_locked ? '🔒 Закрыт' : '🔓 Открыт', inline: true }
            )
            .setTimestamp();
        const ghostSelectMenu = new StringSelectMenuBuilder()
            .setCustomId('vm_control_select')
            .setPlaceholder('Выберите действие')
            .addOptions(
                { label: '📝 Переименовать', value: 'rename', description: 'Изменить название канала' },
                { label: '👥 Лимит', value: 'limit', description: 'Установить лимит пользователей' },
                { label: updatedSettings?.is_locked ? '🔓 Открыть' : '🔒 Закрыть', value: 'lock', description: updatedSettings?.is_locked ? 'Открыть доступ к каналу' : 'Закрыть доступ к каналу' },
                { label: '📊 Битрейт', value: 'bitrate', description: 'Изменить качество звука' },
                { label: '🚫 Отклонить', value: 'reject', description: 'Заблокировать доступ пользователя/роли' },
                { label: '✅ Пригласить', value: 'invite', description: 'Пригласить пользователя в канал' },
                { label: '👻 Скрыть', value: 'ghost', description: 'Сделать канал невидимым' },
                { label: '👁️ Показать', value: 'unghost', description: 'Сделать канал видимым' },
                { label: '🔄 Передать', value: 'transfer', description: 'Передать владение каналом' }
            );
        const ghostRow = new ActionRowBuilder().addComponents(ghostSelectMenu);
        await interaction.update({ content: ghost ? '✅ Канал теперь невидим (Ghost mode)' : '✅ Канал теперь видим (Unghost mode)', embeds: [ghostEmbed], components: [ghostRow] });
    }

    // Функция показа модального окна для Transfer
    async function showTransferModal(interaction) {
        const transferModal = new ModalBuilder()
            .setCustomId('vm_transfer_modal')
            .setTitle('Передать владение каналом');

        const userIdInput = new TextInputBuilder()
            .setCustomId('target_id')
            .setLabel('ID нового владельца')
            .setPlaceholder('Discord ID пользователя')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const row = new ActionRowBuilder().addComponents(userIdInput);
        transferModal.addComponents(row);
        await interaction.showModal(transferModal);
    }
};
