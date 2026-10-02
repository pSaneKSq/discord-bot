require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const db = require('./db.js');
const { sendLog } = require('./logger.js');

// Защита: если где-то в коде вылезет необработанная ошибка,
// процесс больше не будет падать целиком — только запишет ошибку в консоль.
process.on('uncaughtException', (err) => {
    console.error('❌ [Критическая ошибка] Необработанное исключение:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ [Критическая ошибка] Необработанный отказ промиса:', reason);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessageReactions, // Важно для обработки реакций
        GatewayIntentBits.GuildBans, // Для отслеживания банов/разбанов
        GatewayIntentBits.GuildWebhooks // Для отслеживания вебхуков
    ],
    // Нужно, чтобы бот получал события правки/удаления старых (не попавших в кэш) сообщений
    partials: [Partials.Message, Partials.Reaction, Partials.Channel] // Добавили Partials.Reaction для старых реакций
});

client.setMaxListeners(30); // Убираем предупреждение MaxListenersExceededWarning

client.once('ready', () => {
    console.log(`🤖 Бот успешно запущен как ${client.user.tag}`);
});

// SoundPlayer - система воспроизведения звуков в войсе
// Инициализируем ДО require('./server.js'), чтобы server.js мог получить soundPlayer
const registerSoundPlayer = require('./soundPlayer.js');
const soundPlayer = registerSoundPlayer(client);

// ⚠️ Порядок важен: module.exports должен стоять ДО require('./server.js'),
// потому что server.js берёт client из этого файла.
module.exports = { client, soundPlayer };

// Запускаем веб-сервер. Дополнительные API модерации (moderationApi.js)
// подключаются внутри самого server.js, чтобы не зависеть от порядка загрузки файлов.
require('./server.js');

const initWarnHandler = require('./warnHandler.js');

const registerInteractions = require('./tickets.js');
registerInteractions(client, db, sendLog);

const registerAnalyticsTracking = require('./analyticsTracker.js');
registerAnalyticsTracking(client, db);

// ⚠️ ВАЖНО: initWarnHandler вызывается ТОЛЬКО здесь, один раз на весь бот.
// Не добавляй initWarnHandler(...) больше нигде.
initWarnHandler(client, sendLog);

const registerMenu = require('./menuModule.js');
registerMenu(client);

const registerAdmin = require('./adminModule.js');
registerAdmin(client, sendLog);

const registerModeration = require('./moderation.js');
registerModeration(client, sendLog);

const registerWelcome = require('./welcome.js');
registerWelcome(client, sendLog);

const registerAutomod = require('./automod.js');
registerAutomod(client, sendLog);

// Логи правок и удалений сообщений
const { register: registerMessageLogger } = require('./messageLogger.js');
registerMessageLogger(client, sendLog);

// Автороли (Reaction Roles)
const registerReactionRoles = require('./reactionRoles.js');
registerReactionRoles(client, sendLog);

// Система уровней и XP
const registerLevels = require('./levels.js');
registerLevels(client, sendLog);

// Система защиты сервера
const registerSecurity = require('./security.js');
const securitySystem = registerSecurity(client, sendLog);

// VoiceMaster - система временных голосовых каналов
const registerVoiceMaster = require('./voiceMaster.js');
registerVoiceMaster(client);

// Обработчик кнопок подтверждения для системы защиты
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;
    
    // Обработка кнопок подтверждения
    if (customId.startsWith('confirm_') || customId.startsWith('reject_')) {
        const [action, userId, timestamp] = customId.split('_');
        
        // Проверяем что это подтверждение для текущего пользователя
        if (userId !== interaction.user.id) {
            await interaction.reply({ 
                content: '❌ Эта кнопка не для вас!', 
                ephemeral: true 
            });
            return;
        }

        if (action === 'confirm') {
            await interaction.update({ 
                content: '✅ Действие подтверждено', 
                components: [] 
            });
            // Здесь можно добавить логику подтверждения действия
            console.log(`🛡️ ✅ Пользователь ${interaction.user.username} подтвердил действие`);
        } else if (action === 'reject') {
            await interaction.update({ 
                content: '❌ Действие отклонено', 
                components: [] 
            });
            console.log(`🛡️ ❌ Пользователь ${interaction.user.username} отклонил действие`);
        }
    }
});

db.testConnection();

client.login(process.env.DISCORD_TOKEN);