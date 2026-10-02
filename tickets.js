const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    PermissionFlagsBits,
    EmbedBuilder,
    MessageFlags
} = require('discord.js');

const { getFormsStorage } = require('./formsStore.js');
const { addImageToEmbed } = require('./spaceImages.js');

// Если заявитель не написал в канале собеседования за это время — пингуем модераторов
const INTERVIEW_REMINDER_MINUTES = 15;

// Отслеживание "ждём ответа заявителя" для напоминаний (не персистентно — это нормально,
// т.к. актуально только пока процесс жив, при перезапуске просто не будет повторных напоминаний)
const pendingInterviews = new Map(); // textChannelId -> { applicantId, staffRoleId, moderatorId }

// ==========================================
// МНОГОШАГОВЫЕ ЗАЯВКИ (вопросов больше 5)
// ==========================================
// В модальном окне Discord максимум 5 полей, поэтому вопросы делятся на страницы по 5.
// После каждой страницы (кроме последней) заявитель получает скрытое сообщение с кнопкой
// «Продолжить», а введённые ответы временно лежат в памяти бота.
// ⚠️ MAX_QUESTIONS продублирован в public/js/formQuestions.js — меняй в обоих местах.
const QUESTIONS_PER_MODAL = 5;
const MAX_QUESTIONS = 20;
const APPLICATION_SESSION_MINUTES = 15;

// Незаконченные заявки: "formId:userId" -> { answers: [{label, value}], nextPage, expiresAt }
// Не персистентно: при перезапуске бота заявителю придётся начать заново.
const pendingApplications = new Map();

function sessionKey(formId, userId) {
    return `${formId}:${userId}`;
}

// Возвращает актуальную (не просроченную) сессию заполнения или null
function getSession(formId, userId) {
    const key = sessionKey(formId, userId);
    const session = pendingApplications.get(key);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
        pendingApplications.delete(key);
        return null;
    }
    return session;
}

// Раз в 5 минут вычищаем просроченные черновики, чтобы память не росла
setInterval(() => {
    const now = Date.now();
    for (const [key, session] of pendingApplications) {
        if (session.expiresAt < now) pendingApplications.delete(key);
    }
}, 5 * 60 * 1000).unref();

function getFormQuestions(form) {
    return (form.questions || []).slice(0, MAX_QUESTIONS);
}

// Собирает модальное окно для нужной страницы вопросов
function buildFormModal(form, formId, page) {
    const questions = getFormQuestions(form);
    const totalPages = Math.max(1, Math.ceil(questions.length / QUESTIONS_PER_MODAL));
    const pageQuestions = questions.slice(page * QUESTIONS_PER_MODAL, (page + 1) * QUESTIONS_PER_MODAL);

    const baseTitle = form.embedTitle || 'Заявка';
    // Заголовок модалки — максимум 45 символов
    const title = totalPages > 1
        ? `${baseTitle.slice(0, 38)} (${page + 1}/${totalPages})`
        : baseTitle.slice(0, 45);

    const modal = new ModalBuilder()
        .setCustomId(`form_modal_${formId}_${page}`)
        .setTitle(title);

    pageQuestions.forEach(q => {
        const input = new TextInputBuilder()
            .setCustomId(q.id)
            .setLabel((q.label || 'Вопрос').slice(0, 45))
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(!!q.required);

        if (q.placeholder) input.setPlaceholder(q.placeholder.slice(0, 100));
        if (typeof q.minLength === 'number' && q.minLength > 0) input.setMinLength(Math.min(q.minLength, 4000));
        if (typeof q.maxLength === 'number' && q.maxLength > 0) input.setMaxLength(Math.min(q.maxLength, 4000));

        modal.addComponents(new ActionRowBuilder().addComponents(input));
    });

    return modal;
}

// Разбирает customId модалки: "form_modal_<formId>_<page>".
// Поддерживает и старый формат без страницы ("form_modal_<formId>") — на случай,
// если у кого-то модалка была открыта до обновления бота.
function parseFormModalId(customId, forms) {
    const rest = customId.replace('form_modal_', '');

    if (Object.prototype.hasOwnProperty.call(forms, rest)) {
        return { formId: rest, page: 0 };
    }

    const idx = rest.lastIndexOf('_');
    if (idx !== -1) {
        const formId = rest.slice(0, idx);
        const page = parseInt(rest.slice(idx + 1), 10);
        if (!Number.isNaN(page) && Object.prototype.hasOwnProperty.call(forms, formId)) {
            return { formId, page };
        }
    }

    return { formId: rest, page: 0 };
}

// Лимиты эмбеда Discord: значение поля ≤ 1024 символов, весь эмбед ≤ 6000 символов.
// Ответы в базе сохраняются ПОЛНОСТЬЮ — обрезается только сообщение для модераторов.
const EMBED_TOTAL_LIMIT = 6000;
// Запас на заголовок, футер, поле заявителя, описание и пометки, а также на поля
// «Рассматривает» и «Комментарии модераторов», которые добавляются позже.
const EMBED_OVERHEAD = 1800;

function buildAnswerFields(answers) {
    const names = answers.map(a => String(a.label || 'Вопрос').slice(0, 100) || 'Вопрос');
    const namesLength = names.reduce((sum, n) => sum + n.length, 0);
    const budget = Math.max(
        100,
        Math.min(1024, Math.floor((EMBED_TOTAL_LIMIT - EMBED_OVERHEAD - namesLength) / Math.max(1, answers.length)))
    );

    let truncated = false;
    const fields = answers.map((a, i) => {
        let value = String(a.value || '—');
        if (value.length > budget) {
            value = value.slice(0, budget - 1) + '…';
            truncated = true;
        }
        return { name: names[i], value };
    });

    return { fields, truncated };
}

// Пытается отправить ЛС и возвращает { sent: boolean, reason?: string } вместо тихого проглатывания ошибки —
// так по коду ошибки Discord (например 50007 — у получателя закрыты ЛС с сервера) видно ИМЕННО причину в консоли,
// а не просто "не получилось".
async function trySendDM(user, content) {
    try {
        await user.send(content);
        return { sent: true };
    } catch (err) {
        const code = err.code || err.rawError?.code;
        let reason = err.message;
        if (code === 50007) {
            reason = 'у пользователя закрыты ЛС от участников этого сервера (Discord-настройка приватности)';
        }
        console.warn(`⚠️ Не удалось отправить ЛС пользователю ${user.id}: ${reason} (код: ${code || '—'})`);
        return { sent: false, reason };
    }
}

// ==========================================
// ЗАКРЕПЛЕНИЕ ЗАЯВОК И КОММЕНТАРИИ МОДЕРАТОРОВ
// ==========================================

const CLAIM_FIELD = '🙋 Рассматривает';
const NOTES_FIELD = '💬 Комментарии модераторов';

function shortText(text, max) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Кнопки под заявкой в канале проверки.
// withExtras = false для старых заявок без записи в БД: закрепление и комментарии работают через базу.
function buildReviewRows(buttonKey, claimedBy, withExtras = true) {
    const decisionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`form_accept_${buttonKey}`)
            .setLabel('Принять')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
        new ButtonBuilder()
            .setCustomId(`form_reject_${buttonKey}`)
            .setLabel('Отклонить')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌'),
        new ButtonBuilder()
            .setCustomId(`form_invite_${buttonKey}`)
            .setLabel('Пригласить на разговор')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🎙️')
    );

    const rows = [decisionRow];

    if (withExtras) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`form_claim_${buttonKey}`)
                .setLabel(claimedBy ? 'Снять закрепление' : 'Взять на себя')
                .setStyle(claimedBy ? ButtonStyle.Secondary : ButtonStyle.Primary)
                .setEmoji(claimedBy ? '🔓' : '🙋'),
            new ButtonBuilder()
                .setCustomId(`form_comment_${buttonKey}`)
                .setLabel('Комментарий')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('💬')
        ));
    }

    return rows;
}

// Возвращает копию эмбеда заявки с актуальными полями «Рассматривает» и «Комментарии»
function withReviewInfo(embed, { claimedBy, notes }) {
    const builder = EmbedBuilder.from(embed);
    const fields = (builder.data.fields || []).filter(
        f => !f.name.startsWith(CLAIM_FIELD) && !f.name.startsWith(NOTES_FIELD)
    );

    if (claimedBy) {
        fields.push({ name: CLAIM_FIELD, value: `<@${claimedBy}>` });
    }

    if (notes && notes.length) {
        const lines = notes.slice(-5).map(n => {
            const author = n.author_id ? `<@${n.author_id}>` : `**${n.author_name || 'Модератор'}**`;
            return `${author}: ${shortText(n.text, 140)}`;
        });
        const suffix = notes.length > 5 ? `\n*…показаны последние 5, всего ${notes.length}*` : '';
        fields.push({
            name: `${NOTES_FIELD} (${notes.length})`,
            value: (lines.join('\n') + suffix).slice(0, 1024)
        });
    }

    builder.setFields(fields);
    return builder;
}

async function getApplicationNotes(dbPool, applicationId) {
    const res = await dbPool.query(
        `SELECT author_id, author_name, text, created_at
         FROM member_notes
         WHERE application_id = $1
         ORDER BY created_at ASC, id ASC`,
        [applicationId]
    );
    return res.rows;
}

const STATUS_TEXT = { accepted: 'принята', rejected: 'отклонена', pending: 'на рассмотрении' };

module.exports = function(client, dbPool, sendLog) {

    // Отслеживаем первый ответ заявителя в канале собеседования, чтобы отменить напоминание
    client.on('messageCreate', (message) => {
        if (message.author.bot) return;
        const entry = pendingInterviews.get(message.channel.id);
        if (entry && message.author.id === entry.applicantId) {
            pendingInterviews.delete(message.channel.id);
        }
    });

    client.on('interactionCreate', async (interaction) => {

        // ==========================================
        // СТАРЫЙ ТИКЕТ-ФЛОУ
        // ==========================================

        if (interaction.isButton() && interaction.customId === 'open_ticket') {
            const modal = new ModalBuilder()
                .setCustomId('ticket_modal')
                .setTitle('Создание заявки');

            const nicknameInput = new TextInputBuilder()
                .setCustomId('ticket_nickname')
                .setLabel('Ваш ник и возраст')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Пример: Sanek, 19 лет')
                .setRequired(true);

            const reasonInput = new TextInputBuilder()
                .setCustomId('ticket_reason')
                .setLabel('Причина обращения / Заявка')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Опишите суть вопроса...')
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(nicknameInput),
                new ActionRowBuilder().addComponents(reasonInput)
            );

            await interaction.showModal(modal);
        }

        if (interaction.isModalSubmit() && interaction.customId === 'ticket_modal') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const nickname = interaction.fields.getTextInputValue('ticket_nickname');
            const reason = interaction.fields.getTextInputValue('ticket_reason');
            const guild = interaction.guild;
            const user = interaction.user;

            try {
                let ticketNum = 1;
                if (dbPool) {
                    const countResult = await dbPool.query('SELECT COUNT(*) FROM tickets');
                    ticketNum = parseInt(countResult.rows[0].count) + 1;
                }

                const ticketChannel = await guild.channels.create({
                    name: `ticket-${ticketNum}`,
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                        {
                            id: user.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.AttachFiles,
                                PermissionFlagsBits.ReadMessageHistory
                            ],
                        }
                    ],
                });

                if (dbPool) {
                    await dbPool.query(
                        `INSERT INTO tickets (ticket_number, user_id, channel_id, status) VALUES ($1, $2, $3, $4)`,
                        [ticketNum, user.id, ticketChannel.id, 'open']
                    );
                }

                const ticketEmbed = new EmbedBuilder()
                    .setTitle(`🎫 Тикет #${ticketNum}`)
                    .setColor('#8b5cf6')
                    .addFields(
                        { name: '👤 Ник / Возраст', value: nickname, inline: true },
                        { name: '👤 Пользователь', value: `<@${user.id}>`, inline: true },
                        { name: '📝 Заявка', value: reason }
                    )
                    .setFooter({ text: 'Нажмите кнопку ниже для закрытия тикета' })
                    .setTimestamp();
                
                addImageToEmbed(ticketEmbed, 'ticket');

                const controlRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('close_ticket')
                        .setLabel('🔒 Закрыть тикет')
                        .setStyle(ButtonStyle.Danger)
                );

                await ticketChannel.send({
                    content: `<@${user.id}> Ваша заявка принята!`,
                    embeds: [ticketEmbed],
                    components: [controlRow]
                });

                await interaction.editReply({
                    content: `✅ Ваш тикет успешно создан: ${ticketChannel}`
                });

            } catch (error) {
                console.error('Ошибка создания тикета:', error);
                await interaction.editReply({
                    content: '❌ Произошла ошибка при создании тикета. Проверьте логи.'
                });
            }
        }

        if (interaction.isButton() && interaction.customId === 'close_ticket') {
            const modal = new ModalBuilder()
                .setCustomId('close_ticket_modal')
                .setTitle('Закрытие тикета');

            const reasonInput = new TextInputBuilder()
                .setCustomId('close_reason')
                .setLabel('Причина закрытия (необязательно)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Например: Вопрос решён')
                .setRequired(false);

            modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
            await interaction.showModal(modal);
        }

        if (interaction.isModalSubmit() && interaction.customId === 'close_ticket_modal') {
            await interaction.reply({ content: '🔒 Тикет будет удален через 5 секунд...' });

            const reason = interaction.fields.getTextInputValue('close_reason') || 'Не указана';
            const channel = interaction.channel;

            try {
                if (dbPool) {
                    const ticketRes = await dbPool.query(
                        `SELECT * FROM tickets WHERE channel_id = $1 ORDER BY id DESC LIMIT 1`,
                        [channel.id]
                    );
                    const ticket = ticketRes.rows[0];

                    if (ticket) {
                        await dbPool.query(
                            `UPDATE tickets SET status = 'closed', closed_at = NOW() WHERE id = $1`,
                            [ticket.id]
                        );

                        await dbPool.query(
                            `INSERT INTO ticket_logs (ticket_number, user_id, channel_name, moderator_id, reason, opened_at, closed_at)
                             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                            [ticket.ticket_number, ticket.user_id, channel.name, interaction.user.id, reason, ticket.created_at]
                        );
                    }
                }
            } catch (dbError) {
                console.error('Ошибка записи лога закрытия тикета:', dbError.message);
            }

            setTimeout(async () => {
                try {
                    await channel.delete();
                } catch (err) {
                    console.error('Ошибка при удалении канала:', err);
                }
            }, 5000);
        }

        // ==========================================
        // ДИНАМИЧЕСКИЕ ФОРМЫ ИЗ КОНСТРУКТОРА
        // ==========================================

        // ОТКРЫТИЕ ФОРМЫ (первая страница вопросов)
        if (interaction.isButton() && interaction.customId.startsWith('open_form_')) {
            try {
                const formId = interaction.customId.replace('open_form_', '');
                const forms = getFormsStorage(interaction.guildId);
                const form = forms[formId];

                if (!form) {
                    return interaction.reply({ content: '❌ Эта форма больше не существует.', flags: [MessageFlags.Ephemeral] });
                }

                // Проверка кулдауна через БД (переживает перезапуск бота)
                if (dbPool) {
                    const cooldownRes = await dbPool.query(
                        `SELECT cooldown_until FROM form_cooldowns WHERE form_id = $1 AND user_id = $2`,
                        [formId, interaction.user.id]
                    );
                    const cooldownRow = cooldownRes.rows[0];
                    if (cooldownRow && new Date(cooldownRow.cooldown_until) > new Date()) {
                        const minutesLeft = Math.ceil((new Date(cooldownRow.cooldown_until) - Date.now()) / 60000);
                        return interaction.reply({
                            content: `⏳ Вы сможете подать заявку повторно через ${minutesLeft} мин.`,
                            flags: [MessageFlags.Ephemeral]
                        });
                    }
                }

                const questions = getFormQuestions(form);
                if (!questions.length) {
                    return interaction.reply({ content: '❌ В этой форме не настроено ни одного вопроса.', flags: [MessageFlags.Ephemeral] });
                }

                // Начинаем заполнение заново: старый незаконченный черновик этого пользователя сбрасывается
                pendingApplications.delete(sessionKey(formId, interaction.user.id));

                await interaction.showModal(buildFormModal(form, formId, 0));
            } catch (error) {
                console.error('❌ Ошибка при открытии формы заявки:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ Не удалось открыть форму. Проверьте логи сервера.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
                }
            }
        }

        // КНОПКА «ПРОДОЛЖИТЬ» — открывает следующую страницу вопросов
        if (interaction.isButton() && interaction.customId.startsWith('form_next_')) {
            try {
                const rest = interaction.customId.replace('form_next_', '');
                const idx = rest.lastIndexOf('_');
                const formId = rest.slice(0, idx);
                const page = parseInt(rest.slice(idx + 1), 10);
                const forms = getFormsStorage(interaction.guildId);
                const form = forms[formId];

                if (!form || Number.isNaN(page)) {
                    return interaction.update({ content: '❌ Эта форма больше не существует.', components: [] });
                }

                const session = getSession(formId, interaction.user.id);
                if (!session || session.nextPage !== page) {
                    return interaction.update({
                        content: '⏳ Время заполнения истекло или заявка была начата заново. Нажмите кнопку формы в канале ещё раз.',
                        components: []
                    });
                }

                const totalPages = Math.max(1, Math.ceil(getFormQuestions(form).length / QUESTIONS_PER_MODAL));
                if (page >= totalPages) {
                    return interaction.update({
                        content: '❌ Форма была изменена администрацией. Нажмите кнопку формы в канале ещё раз.',
                        components: []
                    });
                }

                // Продлеваем время на заполнение
                session.expiresAt = Date.now() + APPLICATION_SESSION_MINUTES * 60 * 1000;

                await interaction.showModal(buildFormModal(form, formId, page));
            } catch (error) {
                console.error('❌ Ошибка при открытии следующей страницы формы:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ Не удалось открыть следующую страницу. Проверьте логи сервера.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
                }
            }
        }

        // ОТПРАВКА СТРАНИЦЫ ФОРМЫ (промежуточная или последняя)
        if (interaction.isModalSubmit() && interaction.customId.startsWith('form_modal_')) {
            const forms = getFormsStorage(interaction.guildId);
            const { formId, page } = parseFormModalId(interaction.customId, forms);
            const form = forms[formId];

            // Если модалка была открыта из кнопки «Продолжить» — можно обновлять то же скрытое сообщение
            const fromMessage = typeof interaction.isFromMessage === 'function' && interaction.isFromMessage();

            if (!form) {
                return interaction.reply({ content: '❌ Эта форма больше не существует.', flags: [MessageFlags.Ephemeral] });
            }

            const questions = getFormQuestions(form);
            const totalPages = Math.max(1, Math.ceil(questions.length / QUESTIONS_PER_MODAL));
            const pageQuestions = questions.slice(page * QUESTIONS_PER_MODAL, (page + 1) * QUESTIONS_PER_MODAL);

            // ВАЖНО: до ответа Discord даётся 3 секунды, поэтому на этом шаге никаких запросов к БД
            let pageAnswers;
            try {
                if (!pageQuestions.length) throw new Error('страница вопросов пуста');
                pageAnswers = pageQuestions.map(q => ({
                    label: q.label || 'Вопрос',
                    value: interaction.fields.getTextInputValue(q.id) || '—'
                }));
            } catch (err) {
                console.warn('⚠️ Не удалось прочитать ответы страницы формы (форма могла измениться):', err.message);
                const payload = { content: '❌ Форма была изменена администрацией. Нажмите кнопку формы в канале ещё раз.', components: [] };
                if (fromMessage) return interaction.update(payload);
                return interaction.reply({ ...payload, flags: [MessageFlags.Ephemeral] });
            }

            // Достаём (или создаём) черновик заявки
            let session;
            if (page === 0) {
                session = { answers: [], nextPage: 0, expiresAt: 0 };
            } else {
                session = getSession(formId, interaction.user.id);
                if (!session || session.nextPage !== page) {
                    const payload = {
                        content: '⏳ Время заполнения истекло или заявка была начата заново. Нажмите кнопку формы в канале ещё раз.',
                        components: []
                    };
                    if (fromMessage) return interaction.update(payload);
                    return interaction.reply({ ...payload, flags: [MessageFlags.Ephemeral] });
                }
            }

            session.answers = session.answers.concat(pageAnswers);
            session.nextPage = page + 1;
            session.expiresAt = Date.now() + APPLICATION_SESSION_MINUTES * 60 * 1000;

            // Есть ещё страницы — сохраняем черновик и показываем кнопку «Продолжить»
            if (page + 1 < totalPages) {
                pendingApplications.set(sessionKey(formId, interaction.user.id), session);

                const nextRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`form_next_${formId}_${page + 1}`)
                        .setLabel(`Продолжить (${page + 2}/${totalPages})`)
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('➡️')
                );

                const payload = {
                    content: `✅ Страница ${page + 1} из ${totalPages} сохранена. Нажмите кнопку, чтобы продолжить.\n` +
                             `Ответы хранятся ${APPLICATION_SESSION_MINUTES} минут — если не успеете, придётся начать заново.`,
                    components: [nextRow]
                };

                if (fromMessage) return interaction.update(payload);
                return interaction.reply({ ...payload, flags: [MessageFlags.Ephemeral] });
            }

            // ===== ПОСЛЕДНЯЯ СТРАНИЦА — отправляем заявку модераторам =====
            const answers = session.answers;
            pendingApplications.delete(sessionKey(formId, interaction.user.id));

            if (fromMessage) {
                await interaction.deferUpdate();
            } else {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            }

            const reviewChannelId = form.settings && form.settings.reviewChannelId;
            if (!reviewChannelId) {
                return interaction.editReply({ content: '❌ Для этой формы не настроен канал проверки. Обратитесь к администрации.', components: [] });
            }

            let applicationId = null;
            let sentToReview = false;

            try {
                const reviewChannel = await client.channels.fetch(reviewChannelId);
                if (!reviewChannel) {
                    return interaction.editReply({ content: '❌ Канал проверки не найден. Обратитесь к администрации.', components: [] });
                }

                // Пишем заявку в БД ДО отправки в Discord, чтобы получить её ID
                // и использовать его в customId кнопок принятия/отклонения — так заявку
                // потом легко найти в истории, даже если сообщение в канале удалят.
                // В базе ответы хранятся ПОЛНОСТЬЮ (без обрезки под лимиты эмбеда).
                if (dbPool) {
                    const insertRes = await dbPool.query(
                        `INSERT INTO form_applications (form_id, form_title, user_id, answers, status)
                         VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
                        [formId, form.embedTitle || 'Без названия', interaction.user.id, JSON.stringify(answers)]
                    );
                    applicationId = insertRes.rows[0].id;
                }

                // Для эмбеда ответы при необходимости обрезаются под лимиты Discord
                const { fields: answerFields, truncated } = buildAnswerFields(answers);

                const applicationEmbed = new EmbedBuilder()
                    .setTitle(`📝 Новая заявка: ${form.embedTitle || 'Без названия'}`.slice(0, 256))
                    .setColor(form.embedColor || '#8b5cf6')
                    .addFields(
                        { name: '👤 Заявитель', value: `<@${interaction.user.id}> (${interaction.user.tag})` },
                        ...answerFields
                    )
                    .setFooter({ text: `ID заявки: ${applicationId ?? '—'} • ID заявителя: ${interaction.user.id}` })
                    .setTimestamp();
                
                addImageToEmbed(applicationEmbed, 'form');

                if (truncated) {
                    applicationEmbed.setDescription('⚠️ Некоторые ответы слишком длинные и показаны не полностью. Полный текст — во вкладке «История заявок» на сайте.');
                }

                // Если БД недоступна (applicationId нет) — используем старый формат id
                // (formId_userId), чтобы кнопки хотя бы работали в рамках этой сессии бота.
                const buttonKey = applicationId !== null ? String(applicationId) : `legacy_${formId}_${interaction.user.id}`;

                await reviewChannel.send({
                    embeds: [applicationEmbed],
                    components: buildReviewRows(buttonKey, null, applicationId !== null)
                });
                sentToReview = true;

                const cooldownMinutes = (form.settings && form.settings.cooldownMinutes) || 0;
                if (cooldownMinutes > 0 && dbPool) {
                    const cooldownUntil = new Date(Date.now() + cooldownMinutes * 60000);
                    await dbPool.query(
                        `INSERT INTO form_cooldowns (form_id, user_id, cooldown_until)
                         VALUES ($1, $2, $3)
                         ON CONFLICT (form_id, user_id) DO UPDATE SET cooldown_until = EXCLUDED.cooldown_until`,
                        [formId, interaction.user.id, cooldownUntil]
                    );
                }

                await trySendDM(
                    interaction.user,
                    `📨 Ваша заявка «${form.embedTitle || 'без названия'}» отправлена и находится на рассмотрении.\n` +
                    `Ожидайте решения администрации — вам придёт уведомление сюда же.`
                );

                await interaction.editReply({ content: '✅ Ваша заявка отправлена на рассмотрение администрации!', components: [] });
            } catch (error) {
                console.error('Ошибка отправки заявки формы:', error);

                // Если заявка не дошла до канала проверки — убираем "висящую" запись из БД,
                // чтобы она не болталась в истории со статусом "на рассмотрении" без сообщения в Discord.
                if (dbPool && applicationId !== null && !sentToReview) {
                    await dbPool.query(
                        `DELETE FROM form_applications WHERE id = $1 AND status = 'pending'`,
                        [applicationId]
                    ).catch(() => {});
                }

                await interaction.editReply({ content: '❌ Произошла ошибка при отправке заявки. Обратитесь к администрации.', components: [] }).catch(() => {});
            }
        }

        // ПРИНЯТИЕ / ОТКЛОНЕНИЕ ЗАЯВКИ
        if (interaction.isButton() && (interaction.customId.startsWith('form_accept_') || interaction.customId.startsWith('form_reject_'))) {
            const isAccept = interaction.customId.startsWith('form_accept_');
            const prefix = isAccept ? 'form_accept_' : 'form_reject_';
            const buttonKey = interaction.customId.replace(prefix, '');

            if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: '❌ У вас нет прав на это действие.', flags: [MessageFlags.Ephemeral] });
            }

            const isAdmin = interaction.memberPermissions.has(PermissionFlagsBits.Administrator);

            // Разбираем ключ: либо это ID заявки из БД (число), либо старый формат "legacy_<formId>_<userId>"
            let formId, applicantId, applicationId = null, appState = null;

            if (buttonKey.startsWith('legacy_')) {
                const rest = buttonKey.replace('legacy_', '');
                const lastUnderscore = rest.lastIndexOf('_');
                formId = rest.slice(0, lastUnderscore);
                applicantId = rest.slice(lastUnderscore + 1);
            } else if (dbPool) {
                applicationId = parseInt(buttonKey, 10);
                const appRes = await dbPool.query(`SELECT * FROM form_applications WHERE id = $1`, [applicationId]);
                const appRow = appRes.rows[0];
                if (!appRow) {
                    return interaction.reply({ content: '❌ Заявка не найдена в базе данных.', flags: [MessageFlags.Ephemeral] });
                }
                formId = appRow.form_id;
                applicantId = appRow.user_id;
                appState = appRow;
            } else {
                return interaction.reply({ content: '❌ База данных недоступна — не удалось найти заявку.', flags: [MessageFlags.Ephemeral] });
            }

            const forms = getFormsStorage(interaction.guildId);
            const form = forms[formId];
            if (!form) {
                return interaction.reply({ content: '❌ Эта форма больше не существует.', flags: [MessageFlags.Ephemeral] });
            }

            // Защита от двойного решения: заявку уже обработали или её закрепил другой модератор
            if (appState) {
                if (appState.status !== 'pending') {
                    return interaction.reply({
                        content: `ℹ️ Эта заявка уже обработана (${STATUS_TEXT[appState.status] || appState.status}).`,
                        flags: [MessageFlags.Ephemeral]
                    });
                }
                if (appState.claimed_by && appState.claimed_by !== interaction.user.id && !isAdmin) {
                    return interaction.reply({
                        content: `🔒 Эту заявку уже рассматривает <@${appState.claimed_by}>. Решение принимает он — или он может снять закрепление кнопкой «Снять закрепление».`,
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }

            await interaction.deferUpdate();

            // Атомарно занимаем право на решение: если два модератора нажали одновременно,
            // условие status = 'pending' пропустит только первого.
            if (dbPool && applicationId !== null) {
                try {
                    const upd = await dbPool.query(
                        `UPDATE form_applications
                         SET status = $1, decided_by = $2, decided_at = NOW()
                         WHERE id = $3 AND status = 'pending'
                         RETURNING id`,
                        [isAccept ? 'accepted' : 'rejected', interaction.user.id, applicationId]
                    );
                    if (!upd.rowCount) {
                        return interaction.followUp({
                            content: '⚠️ Эту заявку только что обработал другой модератор.',
                            flags: [MessageFlags.Ephemeral]
                        });
                    }
                } catch (dbError) {
                    console.error('Ошибка обновления статуса заявки:', dbError.message);
                    return interaction.followUp({
                        content: '❌ Не удалось сохранить решение в базе данных. Попробуйте ещё раз.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }

            const decision = isAccept ? form.actions?.accept : form.actions?.reject;
            const guild = interaction.guild;
            let dmResult = { sent: false, reason: 'сообщение не настроено' };

            try {
                const member = await guild.members.fetch(applicantId).catch(() => null);

                if (member && decision) {
                    for (const roleId of decision.addRoles || []) {
                        await member.roles.add(roleId).catch(err => console.warn('Не удалось выдать роль:', err.message));
                    }
                    for (const roleId of decision.removeRoles || []) {
                        await member.roles.remove(roleId).catch(err => console.warn('Не удалось снять роль:', err.message));
                    }
                }

                if (member && decision && decision.dm) {
                    dmResult = await trySendDM(member.user, decision.dm);
                } else if (member && (!decision || !decision.dm)) {
                    console.warn(`ЛС не отправлено: в настройках формы "${form.embedTitle}" не задан текст ${isAccept ? 'принятия' : 'отклонения'}.`);
                }

                const logChannelId = form.settings && form.settings.logChannelId;
                if (logChannelId) {
                    const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
                    if (logChannel) {
                        const logEmbed = new EmbedBuilder()
                            .setTitle(isAccept ? '✅ Заявка принята' : '❌ Заявка отклонена')
                            .setColor(isAccept ? '#22c55e' : '#ef4444')
                            .addFields(
                                { name: 'Форма', value: form.embedTitle || formId, inline: true },
                                { name: 'Заявитель', value: `<@${applicantId}>`, inline: true },
                                { name: 'Решение принял', value: `<@${interaction.user.id}>`, inline: true },
                                { name: 'ЛС заявителю', value: dmResult.sent ? '✅ Доставлено' : `⚠️ Не доставлено (${dmResult.reason})`, inline: false }
                            )
                            .setTimestamp();
                        
                        addImageToEmbed(logEmbed, isAccept ? 'success' : 'error');
                        await logChannel.send({ embeds: [logEmbed] });
                    }
                }

                // Пишем решение в общий журнал модерации (вкладка "Журнал" на сайте)
                if (sendLog) {
                    const decisionText = isAccept ? '✅ принята' : '❌ отклонена';
                    await sendLog(
                        guild,
                        `Заявка **${form.embedTitle || formId}** от <@${applicantId}> ${decisionText} модератором <@${interaction.user.id}>.`,
                        'form_decision'
                    );
                }

                const originalEmbed = interaction.message.embeds[0];
                const updatedEmbed = EmbedBuilder.from(originalEmbed)
                    .setColor(isAccept ? '#22c55e' : '#ef4444')
                    .setTitle(`${isAccept ? '✅ Принято' : '❌ Отклонено'} — ${originalEmbed.title || ''}`.slice(0, 256));

                if (!dmResult.sent) {
                    updatedEmbed.addFields({ name: '⚠️ Внимание', value: `Не удалось отправить ЛС заявителю: ${dmResult.reason}`.slice(0, 1024) });
                }

                await interaction.editReply({ embeds: [updatedEmbed], components: [] });

            } catch (error) {
                console.error('Ошибка обработки решения по заявке:', error);
            }
        }

        // ВЗЯТЬ ЗАЯВКУ НА СЕБЯ / СНЯТЬ ЗАКРЕПЛЕНИЕ
        if (interaction.isButton() && interaction.customId.startsWith('form_claim_')) {
            const buttonKey = interaction.customId.replace('form_claim_', '');

            if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: '❌ У вас нет прав на это действие.', flags: [MessageFlags.Ephemeral] });
            }
            if (!dbPool || buttonKey.startsWith('legacy_')) {
                return interaction.reply({ content: '❌ Для этой заявки закрепление недоступно (нет записи в базе данных).', flags: [MessageFlags.Ephemeral] });
            }

            const isAdmin = interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
            const applicationId = parseInt(buttonKey, 10);

            try {
                const curRes = await dbPool.query(
                    `SELECT status, claimed_by FROM form_applications WHERE id = $1`,
                    [applicationId]
                );
                const cur = curRes.rows[0];

                if (!cur) {
                    return interaction.reply({ content: '❌ Заявка не найдена в базе данных.', flags: [MessageFlags.Ephemeral] });
                }
                if (cur.status !== 'pending') {
                    return interaction.reply({
                        content: `ℹ️ Эта заявка уже обработана (${STATUS_TEXT[cur.status] || cur.status}).`,
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                let newClaim;

                if (cur.claimed_by === interaction.user.id) {
                    // Повторное нажатие владельцем — снимаем закрепление
                    await dbPool.query(
                        `UPDATE form_applications SET claimed_by = NULL, claimed_at = NULL
                         WHERE id = $1 AND claimed_by = $2`,
                        [applicationId, interaction.user.id]
                    );
                    newClaim = null;
                } else if (!cur.claimed_by) {
                    // Свободна — занимаем. Условие claimed_by IS NULL защищает от гонки двух нажатий.
                    const upd = await dbPool.query(
                        `UPDATE form_applications SET claimed_by = $1, claimed_at = NOW()
                         WHERE id = $2 AND claimed_by IS NULL AND status = 'pending'
                         RETURNING claimed_by`,
                        [interaction.user.id, applicationId]
                    );
                    if (!upd.rowCount) {
                        const again = await dbPool.query(`SELECT claimed_by FROM form_applications WHERE id = $1`, [applicationId]);
                        const owner = again.rows[0] && again.rows[0].claimed_by;
                        return interaction.reply({
                            content: owner ? `🔒 Заявку только что взял <@${owner}>.` : '⚠️ Не удалось закрепить заявку, попробуйте ещё раз.',
                            flags: [MessageFlags.Ephemeral]
                        });
                    }
                    newClaim = interaction.user.id;
                } else if (isAdmin) {
                    // Администратор может перехватить заявку у другого модератора (например, если тот ушёл)
                    await dbPool.query(
                        `UPDATE form_applications SET claimed_by = $1, claimed_at = NOW() WHERE id = $2 AND status = 'pending'`,
                        [interaction.user.id, applicationId]
                    );
                    newClaim = interaction.user.id;
                } else {
                    return interaction.reply({
                        content: `🔒 Эту заявку уже рассматривает <@${cur.claimed_by}>.`,
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                const notes = await getApplicationNotes(dbPool, applicationId);
                const updatedEmbed = withReviewInfo(interaction.message.embeds[0], { claimedBy: newClaim, notes });

                await interaction.update({
                    embeds: [updatedEmbed],
                    components: buildReviewRows(buttonKey, newClaim, true)
                });
            } catch (error) {
                console.error('Ошибка закрепления заявки:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ Не удалось закрепить заявку. Проверьте логи бота.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
                }
            }
        }

        // КОММЕНТАРИЙ МОДЕРАТОРА К ЗАЯВКЕ — открываем окно ввода
        if (interaction.isButton() && interaction.customId.startsWith('form_comment_')) {
            const buttonKey = interaction.customId.replace('form_comment_', '');

            if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: '❌ У вас нет прав на это действие.', flags: [MessageFlags.Ephemeral] });
            }
            if (!dbPool || buttonKey.startsWith('legacy_')) {
                return interaction.reply({ content: '❌ Для этой заявки комментарии недоступны (нет записи в базе данных).', flags: [MessageFlags.Ephemeral] });
            }

            const modal = new ModalBuilder()
                .setCustomId(`form_comment_modal_${buttonKey}`)
                .setTitle('Комментарий к заявке');

            const commentInput = new TextInputBuilder()
                .setCustomId('comment_text')
                .setLabel('Комментарий (видят только модераторы)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Например: играл с ним, адекватный / ник совпадает с тем, что банили')
                .setMinLength(1)
                .setMaxLength(1000)
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(commentInput));
            await interaction.showModal(modal);
        }

        // КОММЕНТАРИЙ МОДЕРАТОРА — сохранение
        if (interaction.isModalSubmit() && interaction.customId.startsWith('form_comment_modal_')) {
            const buttonKey = interaction.customId.replace('form_comment_modal_', '');
            const text = interaction.fields.getTextInputValue('comment_text').trim();

            if (!text) {
                return interaction.reply({ content: '❌ Комментарий не может быть пустым.', flags: [MessageFlags.Ephemeral] });
            }

            try {
                const applicationId = parseInt(buttonKey, 10);
                const appRes = await dbPool.query(
                    `SELECT user_id, status, claimed_by FROM form_applications WHERE id = $1`,
                    [applicationId]
                );
                const appRow = appRes.rows[0];

                if (!appRow) {
                    return interaction.reply({ content: '❌ Заявка не найдена в базе данных.', flags: [MessageFlags.Ephemeral] });
                }

                await dbPool.query(
                    `INSERT INTO member_notes (guild_id, user_id, author_id, author_name, application_id, text)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [interaction.guild.id, appRow.user_id, interaction.user.id, interaction.user.username, applicationId, text]
                );

                const fromMessage = typeof interaction.isFromMessage === 'function' && interaction.isFromMessage();

                if (fromMessage && interaction.message.embeds[0] && appRow.status === 'pending') {
                    const notes = await getApplicationNotes(dbPool, applicationId);
                    const updatedEmbed = withReviewInfo(interaction.message.embeds[0], { claimedBy: appRow.claimed_by, notes });
                    await interaction.update({ embeds: [updatedEmbed] });
                } else {
                    await interaction.reply({ content: '✅ Комментарий сохранён.', flags: [MessageFlags.Ephemeral] });
                }
            } catch (error) {
                console.error('Ошибка сохранения комментария к заявке:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ Не удалось сохранить комментарий. Проверьте логи бота.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
                }
            }
        }

        // ПРИГЛАШЕНИЕ ЗАЯВИТЕЛЯ НА РАЗГОВОР
        if (interaction.isButton() && interaction.customId.startsWith('form_invite_')) {
            const buttonKey = interaction.customId.replace('form_invite_', '');

            if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: '❌ У вас нет прав на это действие.', flags: [MessageFlags.Ephemeral] });
            }

            const isAdmin = interaction.memberPermissions.has(PermissionFlagsBits.Administrator);

            let formId, applicantId, applicationId = null;

            if (buttonKey.startsWith('legacy_')) {
                const rest = buttonKey.replace('legacy_', '');
                const lastUnderscore = rest.lastIndexOf('_');
                formId = rest.slice(0, lastUnderscore);
                applicantId = rest.slice(lastUnderscore + 1);
            } else if (dbPool) {
                applicationId = parseInt(buttonKey, 10);
                const appRes = await dbPool.query(`SELECT * FROM form_applications WHERE id = $1`, [applicationId]);
                const appRow = appRes.rows[0];
                if (!appRow) {
                    return interaction.reply({ content: '❌ Заявка не найдена в базе данных.', flags: [MessageFlags.Ephemeral] });
                }
                formId = appRow.form_id;
                applicantId = appRow.user_id;

                // Если заявку закрепил другой модератор — приглашать заявителя должен он
                if (appRow.claimed_by && appRow.claimed_by !== interaction.user.id && !isAdmin) {
                    return interaction.reply({
                        content: `🔒 Эту заявку уже рассматривает <@${appRow.claimed_by}>. Приглашать на разговор должен он.`,
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            } else {
                return interaction.reply({ content: '❌ База данных недоступна — не удалось найти заявку.', flags: [MessageFlags.Ephemeral] });
            }

            const forms = getFormsStorage(interaction.guildId);
            const form = forms[formId];
            if (!form) {
                return interaction.reply({ content: '❌ Эта форма больше не существует.', flags: [MessageFlags.Ephemeral] });
            }

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const guild = interaction.guild;

            try {
                const applicant = await guild.members.fetch(applicantId).catch(() => null);
                if (!applicant) {
                    return interaction.editReply({ content: '❌ Не удалось найти заявителя на сервере (возможно, он покинул сервер).' });
                }

                const botMember = guild.members.me;
                if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
                    return interaction.editReply({ content: '❌ У бота нет права «Управление каналами» — выдайте его в настройках роли бота на сервере.' });
                }

                const staffRoleId = form.settings && form.settings.interviewRoleId;

                const permissionOverwrites = [
                    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    {
                        id: applicant.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.Connect,
                            PermissionFlagsBits.Speak,
                            PermissionFlagsBits.ReadMessageHistory
                        ]
                    },
                    {
                        id: interaction.user.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.Connect,
                            PermissionFlagsBits.Speak,
                            PermissionFlagsBits.ManageChannels,
                            PermissionFlagsBits.ReadMessageHistory
                        ]
                    }
                ];

                if (staffRoleId) {
                    permissionOverwrites.push({
                        id: staffRoleId,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.Connect,
                            PermissionFlagsBits.Speak,
                            PermissionFlagsBits.ReadMessageHistory
                        ]
                    });
                }

                const safeUsername = applicant.user.username
                    .toLowerCase()
                    .replace(/[^a-z0-9а-яё]/gi, '')
                    .slice(0, 20) || applicant.id;

                const textChannel = await guild.channels.create({
                    name: `собеседование-${safeUsername}`,
                    type: ChannelType.GuildText,
                    permissionOverwrites
                });

                const voiceChannel = await guild.channels.create({
                    name: `🎙️ Собеседование ${safeUsername}`,
                    type: ChannelType.GuildVoice,
                    permissionOverwrites
                });

                const closeRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`close_interview_${textChannel.id}_${voiceChannel.id}`)
                        .setLabel('🔒 Закрыть каналы собеседования')
                        .setStyle(ButtonStyle.Danger)
                );

                const introEmbed = new EmbedBuilder()
                    .setTitle('🎙️ Собеседование по заявке')
                    .setColor('#8b5cf6')
                    .setDescription(
                        `Форма: **${form.embedTitle || 'Без названия'}**\n\n` +
                        `Здесь можно обсудить заявку в переписке. Голосовой канал: ${voiceChannel}`
                    )
                    .setTimestamp();
                
                addImageToEmbed(introEmbed, 'ticket');

                await textChannel.send({
                    content: `<@${applicant.id}> ${staffRoleId ? `<@&${staffRoleId}>` : `<@${interaction.user.id}>`}`,
                    embeds: [introEmbed],
                    components: [closeRow]
                });

                if (dbPool && applicationId !== null) {
                    await dbPool.query(
                        `UPDATE form_applications SET invited_by = $1, invited_at = NOW() WHERE id = $2`,
                        [interaction.user.id, applicationId]
                    );
                }

                pendingInterviews.set(textChannel.id, {
                    applicantId: applicant.id,
                    staffRoleId,
                    moderatorId: interaction.user.id
                });

                setTimeout(async () => {
                    if (!pendingInterviews.has(textChannel.id)) return;
                    pendingInterviews.delete(textChannel.id);

                    try {
                        const channel = await guild.channels.fetch(textChannel.id).catch(() => null);
                        if (!channel) return;

                        const pingTarget = staffRoleId ? `<@&${staffRoleId}>` : `<@${interaction.user.id}>`;
                        await channel.send(
                            `⏰ ${pingTarget} Заявитель <@${applicant.id}> ещё не ответил в этом канале спустя ${INTERVIEW_REMINDER_MINUTES} минут.`
                        );
                    } catch (err) {
                        console.error('Ошибка напоминания о собеседовании:', err.message);
                    }
                }, INTERVIEW_REMINDER_MINUTES * 60 * 1000);

                await trySendDM(
                    applicant.user,
                    `🎙️ Администрация пригласила вас на разговор по вашей заявке «${form.embedTitle || 'без названия'}».\n` +
                    `Загляните на сервер — для вас открыт текстовый канал: ${textChannel}`
                );

                await interaction.editReply({
                    content: `✅ Каналы созданы: ${textChannel} и голосовой канал «${voiceChannel.name}».`
                });

            } catch (error) {
                console.error('Ошибка при создании каналов собеседования:', error);
                await interaction.editReply({ content: '❌ Не удалось создать каналы для разговора. Проверьте логи сервера.' });
            }
        }

        // ЗАКРЫТИЕ ВРЕМЕННЫХ КАНАЛОВ СОБЕСЕДОВАНИЯ
        if (interaction.isButton() && interaction.customId.startsWith('close_interview_')) {
            if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: '❌ У вас нет прав на это действие.', flags: [MessageFlags.Ephemeral] });
            }

            const rest = interaction.customId.replace('close_interview_', '');
            const [textChannelId, voiceChannelId] = rest.split('_');

            pendingInterviews.delete(textChannelId);

            await interaction.reply({ content: '🔒 Каналы собеседования будут удалены через 5 секунд...' });

            setTimeout(async () => {
                try {
                    const textChannel = await interaction.guild.channels.fetch(textChannelId).catch(() => null);
                    if (textChannel) await textChannel.delete().catch(() => {});

                    const voiceChannel = await interaction.guild.channels.fetch(voiceChannelId).catch(() => null);
                    if (voiceChannel) await voiceChannel.delete().catch(() => {});
                } catch (err) {
                    console.error('Ошибка при удалении каналов собеседования:', err);
                }
            }, 5000);
        }

    });
};