// Собирает данные публичной страницы: контент из clanStore + живые данные из Discord.
const store = require('./clanStore.js');
const siteSettings = require('./siteSettings.js');

const avatars = new Map(); // userId -> { url, name, at }
let lastFullFetch = 0;

function getGuild(client) {
    const id = store.get().guildId || siteSettings.getSettings().defaultGuildId || process.env.GUILD_ID;
    return client && client.isReady() ? client.guilds.cache.get(id) : null;
}

async function discordUser(client, id) {
    const c = avatars.get(id);
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c;
    let rec = { url: '', name: '', at: Date.now() };
    try {
        const u = await client.users.fetch(id);
        rec = { url: u.displayAvatarURL({ size: 512, extension: 'png' }), name: u.globalName || u.username, at: Date.now() };
    } catch { /* пользователь не найден */ }
    avatars.set(id, rec);
    return rec;
}

async function withDiscord(client, p) {
    if (!p.discordId || !client || !client.isReady()) return { ...p, img: p.photo };
    const u = await discordUser(client, p.discordId);
    return { ...p, name: p.name || u.name, img: p.photo || u.url };
}

// Участники с выбранной ролью. Кэш участников обновляется событиями Discord сам,
// полная перезагрузка — раз в 10 минут, поэтому выдача/снятие роли видны сразу.
async function getMembers(guild, roleId) {
    if (!guild || !roleId) return null;
    if (Date.now() - lastFullFetch > 10 * 60 * 1000) {
        lastFullFetch = Date.now();
        try { await guild.members.fetch(); } catch (e) { console.warn('[clan] не удалось обновить участников:', e.message); }
    }
    const role = guild.roles.cache.get(roleId);
    if (!role) return [];
    return [...role.members.values()]
        .filter(m => !m.user.bot)
        .map(m => ({ name: m.displayName, avatar: m.displayAvatarURL({ size: 128, extension: 'png' }) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

async function build(client) {
    const d = store.get();
    const guild = getGuild(client);
    const [leaders, staff, members] = await Promise.all([
        Promise.all(d.leaders.map(p => withDiscord(client, p))),
        Promise.all(d.staff.map(p => withDiscord(client, p))),
        getMembers(guild, d.sections.members.roleId)
    ]);
    return { ...d, leaders, staff, members };
}

module.exports = { build, getGuild };