const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const store = require('./announcementStore.js');
const { addImageToEmbed } = require('./spaceImages.js');

const CHECK_INTERVAL_MS = 30 * 1000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

let logFn = null; // sendLog из index.js
let tickRunning = false;

// ---------- Проверка входных данных ----------

function sanitizePayload(body) {
    body = body || {};

    const payload = {
        channelId: String(body.channelId || '').trim(),
        title: String(body.title || '').trim(),
        description: String(body.description || '').trim(),
        color: String(body.color || '#8b5cf6').trim(),
        author: String(body.author || '').trim(),
        imageUrl: String(body.imageUrl || '').trim(),
        imageData: String(body.imageData || ''),
        pingRole: String(body.pingRole || '').trim()
    };

    if (!/^\d{15,25}$/.test(payload.channelId)) {
        throw new Error('Выберите канал для отправки');
    }
    if (payload.title.length > 256) throw new Error('Заголовок длиннее 256 символов');
    if (payload.description.length > 4096) throw new Error('Основной текст длиннее 4096 символов');
    if (payload.author.length > 256) throw new Error('Имя автора длиннее 256 символов');
    if (!/^#[0-9a-fA-F]{6}$/.test(payload.color)) payload.color = '#8b5cf6';

    if (payload.imageUrl && !/^https?:\/\//i.test(payload.imageUrl)) {
        throw new Error('Ссылка на картинку должна начинаться с http:// или https://');
    }

    if (payload.imageData) {
        const comma = payload.imageData.indexOf(',');
        const header = comma > 0 ? payload.imageData.slice(0, comma) : '';
        if (!/^data:image\/(png|jpe?g|gif|webp);base64$/i.test(header)) {
            throw new Error('Поддерживаются картинки PNG, JPG, GIF и WEBP');
        }
        // base64 занимает ~4/3 от размера файла
        if ((payload.imageData.length - comma) * 0.75 > MAX_IMAGE_BYTES) {
            throw new Error('Картинка слишком большая (максимум 8 МБ)');
        }
    }

    if (payload.pingRole && payload.pingRole !== 'everyone' && !/^\d{15,25}$/.test(payload.pingRole)) {
        payload.pingRole = '';
    }

    if (!payload.title && !payload.description && !payload.imageUrl && !payload.imageData) {
        throw new Error('Заполните хотя бы заголовок, текст или картинку');
    }

    return payload;
}

// ---------- Сборка сообщения Discord ----------

function buildMessage(payload) {
    const embed = new EmbedBuilder().setColor(payload.color || '#8b5cf6');

    if (payload.title) embed.setTitle(payload.title);
    if (payload.description) embed.setDescription(payload.description);
    if (payload.author) embed.setAuthor({ name: payload.author });

    const files = [];
    if (payload.imageData) {
        const comma = payload.imageData.indexOf(',');
        const header = payload.imageData.slice(0, comma);
        const base64 = payload.imageData.slice(comma + 1);
        const ext = header.match(/image\/(png|jpe?g|gif|webp)/i)[1].toLowerCase().replace('jpeg', 'jpg');
        const fileName = `image.${ext}`;
        files.push(new AttachmentBuilder(Buffer.from(base64, 'base64'), { name: fileName }));
        embed.setImage(`attachment://${fileName}`);
    } else if (payload.imageUrl) {
        embed.setImage(payload.imageUrl);
    } else {
        // Если нет своей картинки, добавляем космическую
        addImageToEmbed(embed, 'announcement');
    }

    let content = null;
    let allowedMentions = { parse: [] };
    if (payload.pingRole === 'everyone') {
        content = '@everyone';
        allowedMentions = { parse: ['everyone'] };
    } else if (payload.pingRole) {
        content = `<@&${payload.pingRole}>`;
        allowedMentions = { roles: [payload.pingRole] };
    }

    return { content, embeds: [embed], files, allowedMentions };
}

// ---------- Вспомогательное ----------

async function fetchGuildTextChannel(client, channelId) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new Error('Канал не найден');
    if (!channel.isTextBased()) {
        throw new Error('Этот канал недоступен: он не текстовый');
    }
    return channel;
}

function friendlyError(err) {
    if (!err) return 'Неизвестная ошибка';
    if (err.code === 50013 || err.code === 50001) {
        return 'У бота нет доступа к каналу или права отправлять сообщения / прикреплять файлы';
    }
    if (err.code === 10008) return 'Сообщение не найдено (проверьте ID сообщения и канал)';
    if (err.code === 10003) return 'Канал не найден';
    return err.message || 'Неизвестная ошибка';
}

async function writeLog(client, guildId, text) {
    if (!logFn) return;
    try {
        const guild = client.guilds.cache.get(guildId);
        if (guild) await logFn(guild, text, 'other');
    } catch (err) {
        console.warn('Не удалось записать объявление в журнал:', err.message);
    }
}

function titleForLog(payload) {
    return payload.title ? `«${payload.title}»` : 'без заголовка';
}

// ---------- Отправка и редактирование ----------

async function sendAnnouncement(client, payload, meta = {}) {
    if (!client || !client.isReady()) throw new Error('Discord-бот ещё не готов');

    const channel = await fetchGuildTextChannel(client, payload.channelId);
    const message = await channel.send(buildMessage(payload));

    await writeLog(
        client,
        channel.guildId,
        `📢 Объявление ${titleForLog(payload)} отправлено в <#${payload.channelId}> (${meta.source || 'вручную'}${meta.by ? `, ${meta.by}` : ''}).`
    );
    return message;
}

async function editAnnouncement(client, messageId, payload, meta = {}) {
    if (!client || !client.isReady()) throw new Error('Discord-бот ещё не готов');
    if (!/^\d{15,25}$/.test(String(messageId || ''))) throw new Error('Укажите корректный ID сообщения');

    const channel = await fetchGuildTextChannel(client, payload.channelId);
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) throw new Error('Сообщение не найдено (проверьте ID сообщения и канал)');
    if (message.author.id !== client.user.id) throw new Error('Бот может редактировать только свои собственные сообщения');

    const built = buildMessage(payload);
    await message.edit({
        content: built.content,
        embeds: built.embeds,
        files: built.files,
        attachments: [],
        allowedMentions: built.allowedMentions
    });

    await writeLog(
        client,
        channel.guildId,
        `✏️ Объявление ${titleForLog(payload)} в <#${payload.channelId}> отредактировано${meta.by ? ` (${meta.by})` : ''}.`
    );
    return message;
}

// ---------- Планировщик ----------

async function tick(client) {
    if (tickRunning || !client.isReady()) return;
    tickRunning = true;

    try {
        const now = Date.now();
        const due = store.getScheduled().filter(
            item => item.status === 'pending' && new Date(item.sendAt).getTime() <= now
        );

        for (const item of due) {
            try {
                await sendAnnouncement(client, item.payload, { source: 'по расписанию' });
                store.removeScheduled(item.id);
            } catch (err) {
                console.error(`❌ Не удалось отправить запланированное объявление ${item.id}:`, err.message);
                store.updateScheduled(item.id, { status: 'failed', error: friendlyError(err) });
            }
        }
    } catch (err) {
        console.error('❌ Ошибка планировщика объявлений:', err);
    } finally {
        tickRunning = false;
    }
}

function register(client, sendLog) {
    logFn = sendLog || null;

    // Первая проверка через 10 секунд после старта — подхватит пропущенное за время простоя
    setTimeout(() => tick(client), 10 * 1000);
    setInterval(() => tick(client), CHECK_INTERVAL_MS);
}

module.exports = {
    register,
    sanitizePayload,
    sendAnnouncement,
    editAnnouncement,
    friendlyError
};