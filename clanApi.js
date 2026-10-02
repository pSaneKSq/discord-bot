// API редактора страницы клана. Только владелец.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./clanStore.js');
const site = require('./clanSite.js');

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'clan');

function sniff(b) {
    if (b[0] === 0x89 && b[1] === 0x50) return 'png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
    if (b.slice(0, 4).toString() === 'GIF8') return 'gif';
    if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'webp';
    return null;
}

module.exports = function (app, { client, requireOwner, upload }) {
    app.get('/api/clan', requireOwner, (req, res) => res.json(store.get()));

    app.put('/api/clan', requireOwner, (req, res) => {
        try { res.json(store.save(req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/clan/roles', requireOwner, (req, res) => {
        const g = site.getGuild(client);
        if (!g) return res.json({ guildName: '', roles: [] });
        const roles = [...g.roles.cache.values()]
            .filter(r => r.id !== g.id && !r.managed)
            .sort((a, b) => b.position - a.position)
            .map(r => ({ id: r.id, name: r.name }));
        res.json({ guildName: g.name, roles });
    });

    app.post('/api/clan/upload', requireOwner, upload.single('image'), (req, res) => {
        const f = req.file;
        console.log('[clan upload] файл получен:', f ? 'да' : 'нет', f);
        if (!f) return res.status(400).json({ error: 'Файл не получен' });
        try {
            console.log('[clan upload] размер файла:', f.size);
            if (f.size > 8 * 1024 * 1024) throw new Error('Файл больше 8 МБ');
            const fd = fs.openSync(f.path, 'r');
            const head = Buffer.alloc(12);
            fs.readSync(fd, head, 0, 12, 0);
            fs.closeSync(fd);
            const ext = sniff(head);
            console.log('[clan upload] расширение:', ext);
            if (!ext) throw new Error('Допустимы PNG, JPG, GIF и WEBP');
            fs.mkdirSync(UPLOAD_DIR, { recursive: true });
            const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
            const targetPath = path.join(UPLOAD_DIR, name);
            console.log('[clan upload] перемещаем из', f.path, 'в', targetPath);
            fs.renameSync(f.path, targetPath);
            console.log('[clan upload] успешно:', '/uploads/clan/' + name);
            res.json({ url: '/uploads/clan/' + name });
        } catch (e) {
            console.error('[clan upload] ошибка:', e);
            try { fs.unlinkSync(f.path); } catch { /* уже удалён */ }
            res.status(400).json({ error: e.message });
        }
    });
};