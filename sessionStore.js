// Файловое хранилище сессий: вход переживает перезапуск бота.
const session = require('express-session');
const fs = require('fs');
const path = require('path');

class FileStore extends session.Store {
    constructor(dir) {
        super();
        this.dir = dir;
        fs.mkdirSync(dir, { recursive: true });
        const old = Date.now() - 35 * 24 * 3600 * 1000;
        for (const f of fs.readdirSync(dir)) {
            try { if (fs.statSync(path.join(dir, f)).mtimeMs < old) fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
        }
    }
    file(sid) { return path.join(this.dir, String(sid).replace(/[^\w-]/g, '_') + '.json'); }
    get(sid, cb) {
        fs.readFile(this.file(sid), 'utf8', (err, raw) => {
            if (err) return cb(null, null);
            try {
                const s = JSON.parse(raw);
                if (s.cookie && s.cookie.expires && new Date(s.cookie.expires) < new Date()) return this.destroy(sid, () => cb(null, null));
                cb(null, s);
            } catch { cb(null, null); }
        });
    }
    set(sid, s, cb) { fs.writeFile(this.file(sid), JSON.stringify(s), e => cb && cb(e)); }
    touch(sid, s, cb) { this.set(sid, s, cb); }
    destroy(sid, cb) { fs.unlink(this.file(sid), () => cb && cb()); }
}

module.exports = FileStore;