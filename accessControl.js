// Хранилище белого списка Discord ID для входа через OAuth2.
// При первом запуске сидируется значениями из .env (ALLOWED_DISCORD_IDS),
// дальше редактируется только через UI (страница "Настройки") — .env больше не трогаем.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE_PATH = path.join(DATA_DIR, 'allowedIds.json');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function loadFromDisk() {
    ensureDataDir();

    if (!fs.existsSync(FILE_PATH)) {
        // Первый запуск — сидируем из .env
        const seeded = (process.env.ALLOWED_DISCORD_IDS || '')
            .split(',')
            .map(id => id.trim())
            .filter(Boolean);
        saveToDisk(seeded);
        return seeded;
    }

    try {
        const raw = fs.readFileSync(FILE_PATH, 'utf-8');
        if (!raw.trim()) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error('[accessControl] Ошибка чтения allowedIds.json:', err.message);
        return [];
    }
}

function saveToDisk(list) {
    ensureDataDir();
    fs.writeFileSync(FILE_PATH, JSON.stringify(list, null, 2), 'utf-8');
}

let allowedIds = loadFromDisk();

function getAllowedIds() {
    return [...allowedIds];
}

function isAllowed(discordId) {
    return allowedIds.includes(String(discordId));
}

function addAllowedId(discordId) {
    const id = String(discordId).trim();
    if (!id) return false;
    if (allowedIds.includes(id)) return false;
    allowedIds.push(id);
    saveToDisk(allowedIds);
    return true;
}

function removeAllowedId(discordId) {
    const id = String(discordId).trim();
    const before = allowedIds.length;
    allowedIds = allowedIds.filter(existing => existing !== id);
    if (allowedIds.length !== before) {
        saveToDisk(allowedIds);
        return true;
    }
    return false;
}

module.exports = { getAllowedIds, isAllowed, addAllowedId, removeAllowedId };