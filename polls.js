const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    EmbedBuilder,
    PermissionFlagsBits,
    MessageFlags
} = require('discord.js');
const store = require('./pollStore.js');
const db = require('./db.js');
const { addImageToEmbed } = require('./spaceImages.js');

const CHECK_INTERVAL_MS = 30 * 1000;
const EPHEMERAL = { flags: [MessageFlags.Ephemeral] };

let logFn = null;
let tickRunning = false;
const busy = new Set(); // id предложений, которые прямо сейчас обрабатываются (защита от двойного нажатия)

// ---------- Вспомогательное ----------

function trunc(text, max) {
    const t = String(text || '');
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Функция-замена, чтобы символы «$» в тексте не воспринимались как шаблоны replace
function fill(text, ctx) {
    return String(text || '')
        .replace(/\{question\}/g, () => ctx.question || '')
        .replace(/\{reason\}/g, () => ctx.reason || '');
}

function friendlyError(err) {
    if (!err) return 'Неизвестная ошибка';
    if (err.code === 50013 || err.code === 50001) {
        return 'У бота нет доступа к каналу или права «Отправлять сообщения» / «Отправлять опросы»';
    }
    if (err.code === 10003) return 'Канал не найден';
    return err.message || 'Неизвестная ошибка';
}

async function fetchTextChannel(client, channelId, guildId) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new Error('Канал не найден');
    if (!channel.isTextBased() || channel.guildId !== guildId) {
        throw new Error('Этот канал недоступен: он не на вашем сервере или не текстовый');
    }
    return channel;
}

async function writeLog(client, text, guildId) {
    if (!logFn) return;
    try {
        const guild = client.guilds.cache.get(guildId);
        if (guild) await logFn(guild, text, 'poll');
    } catch (err) {
        console.warn('Не удалось записать событие опроса в журнал:', err.message);
    }
}

async function trySendDM(client, userId, text) {
    try {
        const user = await client.users.fetch(userId);
        await user.send(text);
        return true;
    } catch (err) {
        console.warn(`⚠️ Не удалось отправить ЛС пользователю ${userId} (опросы): ${err.message}`);
        return false;
    }
}

function fmtLeft(ms) {
    const totalMin = Math.max(1, Math.ceil(ms / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h ? `${h} ч ${m} мин` : `${m} мин`;
}

// Дублирует запись в PostgreSQL (для истории). Основное хранилище — JSON, поэтому ошибки не критичны.
async function mirrorToDb(s, guildId) {
    try {
        await db.query(
            `INSERT INTO poll_suggestions
                (id, guild_id, author_id, author_name, question, options, status, rejection_reason,
                 decided_by, published_channel_id, published_message_id, review_message_id,
                 review_message_channel_id, created_at, decided_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (id) DO UPDATE SET
                question = EXCLUDED.question, options = EXCLUDED.options, status = EXCLUDED.status,
                rejection_reason = EXCLUDED.rejection_reason, decided_by = EXCLUDED.decided_by,
                published_channel_id = EXCLUDED.published_channel_id,
                published_message_id = EXCLUDED.published_message_id,
                review_message_id = EXCLUDED.review_message_id,
                review_message_channel_id = EXCLUDED.review_message_channel_id,
                decided_at = EXCLUDED.decided_at`,
            [s.id, guildId || '', s.authorId, s.authorName || '', s.question,
             JSON.stringify(s.options), s.status, s.rejectionReason || '', s.decidedBy || null,
             s.publishedChannelId, s.publishedMessageId, s.reviewMessageId, s.reviewChannelId,
             s.createdAt, s.decidedAt]
        );
    } catch (err) {
        console.warn('⚠️ Не удалось продублировать предложение опроса в БД:', err.message);
    }
}

function findDuplicate(guildId, question, ignoreId) {
    const norm = question.trim().toLowerCase();
    const found = store.getSuggestions(guildId).find(s =>
        s.id !== ignoreId && s.status !== 'rejected' && s.question.trim().toLowerCase() === norm
    );
    return found ? found.id : null;
}

function isApprover(interaction, settings) {
    const perms = interaction.memberPermissions;
    if (perms && perms.has(PermissionFlagsBits.Administrator)) return true;
    if (!settings.approverRoleId) return !!(perms && perms.has(PermissionFlagsBits.ManageGuild));
    const roles = interaction.member && interaction.member.roles;
    if (roles && roles.cache) return roles.cache.has(settings.approverRoleId);
    return Array.isArray(roles) && roles.includes(settings.approverRoleId);
}

// ---------- Отправка опроса ----------

async function sendPoll(client, poll, { authorId, guildId } = {}) {
    if (!client || !client.isReady()) throw new Error('Discord-бот ещё не готов');

    const channel = await fetchTextChannel(client, poll.channelId, guildId);
    const me = channel.guild && channel.guild.members.me;
    const perms = me && channel.permissionsFor(me);
    if (perms && !perms.has(PermissionFlagsBits.SendPolls)) {
        throw new Error('У бота не хватает права «Отправлять опросы» в этом канале');
    }

    const parts = [];
    let allowedMentions = { parse: [] };
    if (poll.pingRole === 'everyone') {
        parts.push('@everyone');
        allowedMentions = { parse: ['everyone'] };
    } else if (poll.pingRole) {
        parts.push(`<@&${poll.pingRole}>`);
        allowedMentions = { roles: [poll.pingRole] };
    }
    if (authorId) parts.push(`✍️ Предложил: <@${authorId}>`);

    const message = await channel.send({
        content: parts.length ? parts.join('\n') : undefined,
        poll: {
            question: { text: poll.question },
            answers: poll.options.map(text => ({ text })),
            duration: poll.duration,
            allowMultiselect: !!poll.multiselect
        },
        allowedMentions
    });

    store.addHistory(guildId || channel.guildId, {
        question: poll.question,
        options: poll.options,
        duration: poll.duration,
        multiselect: !!poll.multiselect,
        channelId: poll.channelId,
        messageId: message.id,
        authorId: authorId || null
    });
    return message;
}

// Прямая отправка с сайта
async function sendNow(client, body, by, guildId) {
    const poll = store.sanitizePoll(body, { guildId });
    const message = await sendPoll(client, poll, { guildId });
    await writeLog(client, `📊 Опрос **«${trunc(poll.question, 100)}»** отправлен в <#${poll.channelId}> (вручную${by ? `, ${by}` : ''}).`, guildId);
    return message;
}

// ---------- Сообщение в канале проверки ----------

function whoDecided(s) {
    if (s.decidedBy) return `<@${s.decidedBy}>`;
    return s.decidedByName ? `${s.decidedByName} (сайт)` : '—';
}

function buildReviewEmbed(s, guildId) {
    const colors = { pending: '#f59e0b', approved: '#22c55e', rejected: '#ef4444' };
    const titles = {
        pending: '📊 Предложение опроса — ждёт решения',
        approved: '✅ Опрос одобрен',
        rejected: '❌ Опрос отклонён'
    };
    const embed = new EmbedBuilder()
        .setColor(colors[s.status] || colors.pending)
        .setTitle(titles[s.status] || titles.pending)
        .setDescription(`**${trunc(s.question, 300)}**`)
        .addFields(
            { name: 'Варианты ответа', value: trunc(s.options.map((o, i) => `${i + 1}. ${o}`).join('\n'), 1024) },
            { name: 'Предложил', value: `<@${s.authorId}>${s.authorName ? ` (${s.authorName})` : ''}`, inline: true }
        )
        .setFooter({ text: `ID: ${s.id}` })
        .setTimestamp(new Date(s.createdAt));

    if (s.duplicateOf && s.status === 'pending') {
        embed.addFields({ name: '⚠️ Возможный дубль', value: 'Такой вопрос уже предлагали (ожидает или одобрен).', inline: true });
    }
    if (s.status !== 'pending') {
        embed.addFields({ name: 'Решение принял', value: whoDecided(s), inline: true });
    }
    if (s.status === 'approved' && s.publishedChannelId && s.publishedMessageId) {
        embed.addFields({
            name: 'Опубликован',
            value: `https://discord.com/channels/${guildId}/${s.publishedChannelId}/${s.publishedMessageId}`
        });
    }
    if (s.status === 'rejected') {
        embed.addFields({ name: 'Причина', value: trunc(s.rejectionReason || 'не указана', 1024) });
    }

    addImageToEmbed(embed, s.status === 'approved' ? 'success' : (s.status === 'rejected' ? 'error' : 'poll'));
    return embed;
}

function buildReviewRows(s) {
    if (s.status !== 'pending') return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pollv_ok_${s.id}`).setLabel('Одобрить').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId(`pollv_no_${s.id}`).setLabel('Отклонить').setStyle(ButtonStyle.Danger).setEmoji('❌')
    )];
}

// Обновляет сообщение в канале проверки (молча, если оно удалено)
async function refreshReviewMessage(client, s, guildId) {
    if (!s.reviewChannelId || !s.reviewMessageId) return;
    try {
        const channel = await client.channels.fetch(s.reviewChannelId).catch(() => null);
        if (!channel) return;
        const message = await channel.messages.fetch(s.reviewMessageId).catch(() => null);
        if (!message) return;
        await message.edit({ embeds: [buildReviewEmbed(s, guildId)], components: buildReviewRows(s) });
    } catch (err) {
        console.warn('⚠️ Не удалось обновить сообщение предложения опроса:', err.message);
    }
}

// ---------- Решения по предложениям (общая логика для сайта и Discord) ----------

async function approveSuggestion(client, id, { channelId, by, byName, guildId } = {}) {
    if (busy.has(id)) throw new Error('Это предложение уже обрабатывается');
    busy.add(id);
    try {
        const s = store.getSuggestion(guildId, id);
        if (!s) throw new Error('Предложение не найдено');
        if (s.status !== 'pending') throw new Error('Предложение уже обработано');

        const settings = store.getSettings(guildId);
        const target = channelId || settings.publishChannelId;
        if (!target) throw new Error('Не выбран канал публикации (укажите его при одобрении или в настройках)');

        const message = await sendPoll(client, {
            question: s.question,
            options: s.options,
            duration: settings.defaultDuration,
            multiselect: settings.defaultMultiselect,
            channelId: target,
            pingRole: ''
        }, { authorId: s.authorId, guildId });

        const updated = store.updateSuggestion(guildId, id, {
            status: 'approved',
            decidedAt: new Date().toISOString(),
            decidedBy: by || null,
            decidedByName: byName || '',
            publishedChannelId: target,
            publishedMessageId: message.id
        });

        if (settings.dmOnApprove) {
            await trySendDM(client, s.authorId, fill(settings.dmApproveText, { question: s.question }));
        }
        await refreshReviewMessage(client, updated, guildId);
        await mirrorToDb(updated, guildId);
        await writeLog(client, `📊 Опрос **«${trunc(s.question, 100)}»** от <@${s.authorId}> одобрен (${byName || 'модератор'}) и опубликован в <#${target}>.`, guildId);
        return updated;
    } finally {
        busy.delete(id);
    }
}

async function rejectSuggestion(client, id, { reason, by, byName, guildId } = {}) {
    if (busy.has(id)) throw new Error('Это предложение уже обрабатывается');
    busy.add(id);
    try {
        const s = store.getSuggestion(guildId, id);
        if (!s) throw new Error('Предложение не найдено');
        if (s.status !== 'pending') throw new Error('Предложение уже обработано');

        const cleanReason = String(reason || '').trim().slice(0, 500);
        const updated = store.updateSuggestion(guildId, id, {
            status: 'rejected',
            rejectionReason: cleanReason,
            decidedAt: new Date().toISOString(),
            decidedBy: by || null,
            decidedByName: byName || ''
        });

        const settings = store.getSettings(guildId);
        if (settings.dmOnReject) {
            await trySendDM(client, s.authorId, fill(settings.dmRejectText, {
                question: s.question,
                reason: cleanReason ? `\nПричина: ${cleanReason}` : ''
            }));
        }
        await refreshReviewMessage(client, updated, guildId);
        await mirrorToDb(updated, guildId);
        await writeLog(client, `📊 Опрос **«${trunc(s.question, 100)}»** от <@${s.authorId}> отклонён (${byName || 'модератор'}).${cleanReason ? `\nПричина: ${cleanReason}` : ''}`, guildId);
        return updated;
    } finally {
        busy.delete(id);
    }
}

// Правка предложения с сайта (только пока оно не обработано)
async function editSuggestion(client, id, body, guildId) {
    const s = store.getSuggestion(guildId, id);
    if (!s) throw new Error('Предложение не найдено');
    if (s.status !== 'pending') throw new Error('Редактировать можно только предложения, которые ждут решения');

    const question = store.normalizeQuestion(body && body.question);
    const options = store.normalizeOptions(body && body.options);
    const updated = store.updateSuggestion(guildId, id, { question, options, duplicateOf: findDuplicate(guildId, question, id) });

    await refreshReviewMessage(client, updated, guildId);
    await mirrorToDb(updated, guildId);
    return updated;
}

// ---------- Форма «Предложить опрос» ----------

async function publishSuggestionForm(client, guildId) {
    if (!client || !client.isReady()) throw new Error('Discord-бот ещё не готов');
    const settings = store.getSettings(guildId);
    if (!settings.suggestionChannelId) throw new Error('Выберите канал для формы предложений и сохраните настройки');

    const channel = await fetchTextChannel(client, settings.suggestionChannelId, guildId);
    const embed = new EmbedBuilder()
        .setColor(settings.formColor)
        .setTitle(settings.formTitle)
        .setDescription(settings.formDescription);

    addImageToEmbed(embed, 'poll');
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pollv_open').setLabel(settings.formButtonText).setStyle(ButtonStyle.Primary).setEmoji('📊')
    );

    const prev = store.getFormMessage(guildId);
    if (prev && prev.channelId === channel.id) {
        const old = await channel.messages.fetch(prev.messageId).catch(() => null);
        if (old && old.author.id === client.user.id) {
            await old.edit({ embeds: [embed], components: [row] });
            return { message: old, updated: true };
        }
    }
    // Форма была в другом канале — убираем старое сообщение, чтобы не плодить дубли
    if (prev && prev.channelId !== channel.id) {
        const oldChannel = await client.channels.fetch(prev.channelId).catch(() => null);
        const oldMsg = oldChannel && await oldChannel.messages.fetch(prev.messageId).catch(() => null);
        if (oldMsg) await oldMsg.delete().catch(() => {});
    }

    const message = await channel.send({ embeds: [embed], components: [row] });
    store.setFormMessage(guildId, { channelId: channel.id, messageId: message.id });
    return { message, updated: false };
}

// ---------- Обработчики Discord ----------

async function onOpen(interaction) {
    const guildId = interaction.guildId;
    const settings = store.getSettings(guildId);
    if (!settings.reviewChannelId) {
        return interaction.reply({ content: '❌ Приём предложений ещё не настроен администрацией.', ...EPHEMERAL });
    }

    const isAdmin = interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
    const left = store.getCooldown(guildId, interaction.user.id) - Date.now();
    if (left > 0 && !isAdmin) {
        return interaction.reply({ content: `⏳ Следующий опрос можно предложить через ${fmtLeft(left)}.`, ...EPHEMERAL });
    }

    const modal = new ModalBuilder().setCustomId('pollv_modal').setTitle('Предложить опрос');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('question')
                .setLabel('Вопрос (до 300 символов)')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(300)
                .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('options')
                .setLabel('Варианты: каждый с новой строки (2–10)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Вариант 1\nВариант 2\nВариант 3')
                .setMaxLength(1000)
                .setRequired(true)
        )
    );
    await interaction.showModal(modal);
}

async function onSubmit(client, interaction) {
    await interaction.deferReply(EPHEMERAL);

    let question, options;
    try {
        question = store.normalizeQuestion(interaction.fields.getTextInputValue('question'));
        options = store.normalizeOptions(interaction.fields.getTextInputValue('options'));
    } catch (err) {
        return interaction.editReply({ content: `❌ ${err.message}` });
    }

    const guildId = interaction.guildId;
    const settings = store.getSettings(guildId);
    const isAdmin = interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
    const left = store.getCooldown(guildId, interaction.user.id) - Date.now();
    if (left > 0 && !isAdmin) {
        return interaction.editReply({ content: `⏳ Следующий опрос можно предложить через ${fmtLeft(left)}.` });
    }

    const s = store.addSuggestion(guildId, {
        authorId: interaction.user.id,
        authorName: (interaction.member && interaction.member.displayName) || interaction.user.username,
        question,
        options,
        duplicateOf: findDuplicate(guildId, question)
    });
    store.setCooldown(guildId, interaction.user.id, Date.now() + settings.cooldownHours * 3600 * 1000);

    // Сообщение в канале проверки. Если оно не отправилось, предложение всё равно останется на сайте.
    let updated = s;
    if (settings.reviewChannelId) {
        try {
            const channel = await fetchTextChannel(client, settings.reviewChannelId, guildId);
            const msg = await channel.send({ embeds: [buildReviewEmbed(s, guildId)], components: buildReviewRows(s) });
            updated = store.updateSuggestion(guildId, s.id, { reviewMessageId: msg.id, reviewChannelId: channel.id });
        } catch (err) {
            console.error('❌ Не удалось отправить предложение опроса в канал проверки:', err.message);
        }
    }

    if (settings.dmOnSubmit) {
        await trySendDM(client, s.authorId, fill(settings.dmSubmitText, { question }));
    }
    await mirrorToDb(updated, guildId);
    await writeLog(client, `📊 Участник <@${s.authorId}> предложил опрос **«${trunc(question, 100)}»** (${options.length} вар.).`, guildId);

    await interaction.editReply({ content: '✅ Опрос отправлен на рассмотрение! Результат придёт тебе в личные сообщения.' });
}

async function onApproveOpen(interaction) {
    const guildId = interaction.guildId;
    const settings = store.getSettings(guildId);
    if (!isApprover(interaction, settings)) {
        return interaction.reply({ content: '❌ У вас нет прав рассматривать предложения опросов.', ...EPHEMERAL });
    }
    const id = interaction.customId.slice('pollv_ok_'.length);
    const s = store.getSuggestion(guildId, id);
    if (!s || s.status !== 'pending') {
        return interaction.reply({ content: 'ℹ️ Это предложение уже обработано или удалено.', ...EPHEMERAL });
    }

    const select = new ChannelSelectMenuBuilder()
        .setCustomId(`pollv_okch_${id}`)
        .setPlaceholder('Или выберите другой канал для публикации')
        .setChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement])
        .setMinValues(1)
        .setMaxValues(1);
    const defBtn = new ButtonBuilder()
        .setCustomId(`pollv_okdef_${id}`)
        .setLabel('В канал по умолчанию')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!settings.publishChannelId);

    await interaction.reply({
        content: settings.publishChannelId
            ? `Куда опубликовать опрос? Канал по умолчанию: <#${settings.publishChannelId}>.`
            : 'Канал по умолчанию не задан — выберите канал в списке ниже.',
        components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(defBtn)],
        ...EPHEMERAL
    });
}

async function onApproveDone(client, interaction, id, channelId) {
    await interaction.deferUpdate();
    const guildId = interaction.guildId;
    if (!isApprover(interaction, store.getSettings(guildId))) {
        return interaction.editReply({ content: '❌ У вас нет прав рассматривать предложения опросов.', components: [] });
    }
    try {
        const s = await approveSuggestion(client, id, {
            channelId,
            by: interaction.user.id,
            byName: interaction.user.username,
            guildId
        });
        await interaction.editReply({ content: `✅ Опрос опубликован в <#${s.publishedChannelId}>.`, components: [] });
    } catch (err) {
        await interaction.editReply({ content: `❌ ${friendlyError(err)}`, components: [] });
    }
}

async function onRejectOpen(interaction) {
    const guildId = interaction.guildId;
    if (!isApprover(interaction, store.getSettings(guildId))) {
        return interaction.reply({ content: '❌ У вас нет прав рассматривать предложения опросов.', ...EPHEMERAL });
    }
    const id = interaction.customId.slice('pollv_no_'.length);
    const s = store.getSuggestion(guildId, id);
    if (!s || s.status !== 'pending') {
        return interaction.reply({ content: 'ℹ️ Это предложение уже обработано или удалено.', ...EPHEMERAL });
    }

    const modal = new ModalBuilder().setCustomId(`pollv_nomodal_${id}`).setTitle('Отклонить опрос');
    modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Причина (необязательно)')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(500)
            .setRequired(false)
    ));
    await interaction.showModal(modal);
}

async function onRejectDone(client, interaction) {
    await interaction.deferReply(EPHEMERAL);
    const guildId = interaction.guildId;
    if (!isApprover(interaction, store.getSettings(guildId))) {
        return interaction.editReply({ content: '❌ У вас нет прав рассматривать предложения опросов.' });
    }
    const id = interaction.customId.slice('pollv_nomodal_'.length);
    const reason = interaction.fields.getTextInputValue('reason') || '';
    try {
        await rejectSuggestion(client, id, { reason, by: interaction.user.id, byName: interaction.user.username, guildId });
        await interaction.editReply({ content: '❌ Предложение отклонено, автору отправлено уведомление.' });
    } catch (err) {
        await interaction.editReply({ content: `❌ ${friendlyError(err)}` });
    }
}

// ---------- Отложенные опросы ----------

async function tick(client) {
    if (tickRunning || !client || !client.isReady()) return;
    tickRunning = true;
    try {
        const now = Date.now();
        const allGuilds = store.getAll();
        
        for (const guildId of Object.keys(allGuilds)) {
            const due = store.getScheduled(guildId).filter(i => i.status === 'pending' && new Date(i.sendAt).getTime() <= now);
            for (const item of due) {
                try {
                    await sendPoll(client, item.payload, { guildId });
                    store.removeScheduled(guildId, item.id);
                    await writeLog(client, `📊 Опрос **«${trunc(item.payload.question, 100)}»** отправлен в <#${item.payload.channelId}> (по расписанию).`, guildId);
                } catch (err) {
                    console.error(`❌ Не удалось отправить отложенный опрос ${item.id}:`, err.message);
                    store.updateScheduled(guildId, item.id, { status: 'failed', error: friendlyError(err) });
                }
            }
        }
    } catch (err) {
        console.error('❌ Ошибка планировщика опросов:', err);
    } finally {
        tickRunning = false;
    }
}

function register(client, sendLog) {
    logFn = sendLog || null;

    client.on('interactionCreate', async (interaction) => {
        try {
            const id = interaction.customId || '';
            if (interaction.isButton() && id === 'pollv_open') return await onOpen(interaction);
            if (interaction.isModalSubmit() && id === 'pollv_modal') return await onSubmit(client, interaction);
            if (interaction.isButton() && id.startsWith('pollv_ok_')) return await onApproveOpen(interaction);
            if (interaction.isChannelSelectMenu() && id.startsWith('pollv_okch_')) {
                return await onApproveDone(client, interaction, id.slice('pollv_okch_'.length), interaction.values[0]);
            }
            if (interaction.isButton() && id.startsWith('pollv_okdef_')) {
                return await onApproveDone(client, interaction, id.slice('pollv_okdef_'.length), '');
            }
            if (interaction.isButton() && id.startsWith('pollv_no_')) return await onRejectOpen(interaction);
            if (interaction.isModalSubmit() && id.startsWith('pollv_nomodal_')) return await onRejectDone(client, interaction);
        } catch (err) {
            console.error('❌ Ошибка обработки взаимодействия опросов:', err);
            try {
                const payload = { content: '❌ Что-то пошло не так. Подробности — в консоли бота.', ...EPHEMERAL };
                if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
                else await interaction.reply(payload);
            } catch (e) { /* ответить уже нельзя */ }
        }
    });

    setTimeout(() => tick(client), 12 * 1000);
    setInterval(() => tick(client), CHECK_INTERVAL_MS);
}

module.exports = {
    register,
    sendNow,
    approveSuggestion,
    rejectSuggestion,
    editSuggestion,
    publishSuggestionForm,
    friendlyError
};