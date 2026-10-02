const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const GUILD_ID_RE = /^\d{17,20}$/;
const stores = new Set();
let exitHooked = false;

function hookExit() {
    if (exitHooked) return;
    exitHooked = true;
    // 'exit' срабатывает и при process.exit(); flush синхронный
    process.on('exit', () => stores.forEach(s => s.flush()));
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}

/**
 * @param {string} fileName
 * @param {Function} createDefault - свежие данные для нового сервера
 * @param {{migrateLegacy?: Function}} options - как превратить старый файл в данные одного сервера
 */
function createMultiServerStore(fileName, createDefault = () => ({}), { migrateLegacy = (old) => old } = {}) {
    const file = path.join(DATA_DIR, fileName);
    let lastJson = null;
    const backfilled = new Set();

    function load() {
        if (!fs.existsSync(file)) return {};
        const raw = fs.readFileSync(file, 'utf-8').trim();
        if (!raw) return {};

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            fs.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`);
            console.error(`❌ ${fileName} повреждён, копия сохранена. Старт с пустого хранилища:`, err.message);
            return {};
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const keys = Object.keys(parsed);
        if (keys.length === 0) return {};

        const guildKeys = keys.filter(k => GUILD_ID_RE.test(k));
        if (guildKeys.length === keys.length) return parsed; // уже { guildId: ... }

        if (guildKeys.length > 0) {
            const bad = keys.filter(k => !GUILD_ID_RE.test(k)).slice(0, 5).join(', ');
            throw new Error(`${fileName}: смешанный формат (посторонние ключи: ${bad}). Исправьте файл вручную.`);
        }

        // Старый формат: данные одного сервера без обёртки
        const legacyGuild = process.env.GUILD_ID;
        if (!GUILD_ID_RE.test(legacyGuild || '')) {
            throw new Error(`${fileName}: старый формат, но GUILD_ID в .env не задан. Миграция невозможна.`);
        }
        fs.copyFileSync(file, `${file}.legacy.bak`);
        console.log(`✅ ${fileName}: старый формат перенесён в сервер ${legacyGuild} (копия: .legacy.bak)`);
        return { [legacyGuild]: migrateLegacy(parsed) };
    }

    const data = load();

    function flush() {
        try {
            const json = JSON.stringify(data, null, 2);
            if (json === lastJson) return;
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, json, 'utf-8');
            fs.renameSync(tmp, file);
            lastJson = json;
        } catch (err) {
            console.error(`❌ Ошибка сохранения ${fileName}:`, err.message);
        }
    }

    let timer = null;
    function save() {
        clearTimeout(timer);
        timer = setTimeout(flush, 300);
    }
    setInterval(flush, 10_000).unref(); // подхватывает и вложенные изменения

    function checkId(guildId) {
        const id = String(guildId == null ? '' : guildId);
        if (!GUILD_ID_RE.test(id)) {
            throw new Error(`${fileName}: нужен корректный guildId, получено: ${typeof guildId === 'object' ? 'object' : id || 'пусто'}`);
        }
        return id;
    }

    const api = {
        get(guildId) {
            const id = checkId(guildId);
            if (!data[id]) {
                data[id] = createDefault();
                backfilled.add(id);
                save();
            } else if (!backfilled.has(id)) {
                // дописываем поля, которых нет в старых данных
                const def = createDefault();
                for (const k of Object.keys(def)) if (!(k in data[id])) data[id][k] = def[k];
                backfilled.add(id);
            }
            return data[id];
        },
        set(guildId, value) { data[checkId(guildId)] = value; save(); },
        delete(guildId) { delete data[checkId(guildId)]; save(); },
        getAll() { return data; },
        guildIds() { return Object.keys(data); },
        save,
        flush
    };

    stores.add(api);
    hookExit();
    flush();
    return api;
}

module.exports = { createMultiServerStore };
