// Контент страницы клана (data/clan.json). Редактируется только владельцем через панель.
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'data', 'clan.json');

const DEFAULTS = () => ({
    guildId: '', // пусто = сервер по умолчанию из «Настроек»
    hero: { title: 'Название клана', subtitle: 'Короткий слоган клана', primaryText: 'История клана' },
    about: { title: 'О клане', text: '' },
    sections: {
        history: { title: 'История клана', intro: '' },
        leaders: { title: 'Руководство', intro: '' },
        staff: { title: 'Заместители и администрация', intro: '' },
        members: { title: 'Основа клана', intro: '', roleId: '' },
        gallery: { title: 'Галерея', intro: '' }
    },
    history: [],
    leaders: [1, 2, 3].map(n => ({ id: 'l' + n, name: 'Руководитель ' + n, role: 'Лидер клана', bio: '', photo: '', discordId: '' })),
    staff: [],
    gallery: []
});

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const text = (v, n) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, n);
const img = (v) => { v = str(v, 500); return /^(\/uploads\/clan\/[\w.-]+|https:\/\/[^\s"'<>]+)$/.test(v) ? v : ''; };
const did = (v) => (/^\d{15,25}$/.test(String(v || '').trim()) ? String(v).trim() : '');
const sid = (v) => str(v, 16).replace(/[^\w-]/g, '') || Math.random().toString(36).slice(2, 9);
const pct = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(100, Math.max(10, n)) : d; };
const align = (v) => (['left', 'center', 'right'].includes(v) ? v : 'left');
const list = (a, max, fn) => (Array.isArray(a) ? a : []).slice(0, max).filter(x => x && typeof x === 'object').map(fn);

function sanitize(i) {
    i = i && typeof i === 'object' ? i : {};
    const d = DEFAULTS();
    const L = (k, max, fn) => (i[k] === undefined ? d[k] : list(i[k], max, fn));
    const person = (p) => ({ id: sid(p.id), name: str(p.name, 80), role: str(p.role, 80), bio: text(p.bio, 3000), photo: img(p.photo), discordId: did(p.discordId) });
    const hero = i.hero || {}, about = i.about || {}, sec = i.sections || {};
    const out = {
        guildId: did(i.guildId),
        hero: {
            title: str(hero.title, 80) || d.hero.title,
            subtitle: hero.subtitle === undefined ? d.hero.subtitle : str(hero.subtitle, 200),
            primaryText: str(hero.primaryText, 40) || d.hero.primaryText
        },
        about: { title: str(about.title, 80) || d.about.title, text: text(about.text, 6000) },
        sections: {},
        history: L('history', 300, h => ({ id: sid(h.id), period: str(h.period, 80), date: str(h.date, 60), title: str(h.title, 140), text: text(h.text, 8000), image: img(h.image), imageWidth: pct(h.imageWidth, 100), imageAlign: align(h.imageAlign) })),
        leaders: L('leaders', 6, person),
        staff: L('staff', 60, person),
        gallery: L('gallery', 80, g => ({ id: sid(g.id), url: img(g.url), caption: str(g.caption, 160) })).filter(g => g.url)
    };
    for (const k of Object.keys(d.sections)) {
        const s = sec[k] || {};
        out.sections[k] = { title: str(s.title, 80) || d.sections[k].title, intro: text(s.intro, 600) };
    }
    out.sections.members.roleId = did(sec.members && sec.members.roleId);
    return out;
}

let data;
try { data = sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { data = sanitize({}); }

function get() { return data; }
function save(input) {
    data = sanitize(input);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
    return data;
}

module.exports = { get, save };