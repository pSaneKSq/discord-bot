// Хранилище общих настроек внешнего вида сайта (акцентный цвет и т.д.)
// Редактируется только через страницу "Настройки" (видна только владельцу).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE_PATH = path.join(DATA_DIR, 'siteSettings.json');

const DEFAULT_SETTINGS = {
    accentColor: '#8b5cf6',
    accentColorSecondary: '#5865F2',
    siteName: 'Dashboard',
    defaultGuildId: ''
};

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function loadFromDisk() {
    ensureDataDir();

    if (!fs.existsSync(FILE_PATH)) {
        saveToDisk(DEFAULT_SETTINGS);
        return { ...DEFAULT_SETTINGS };
    }

    try {
        const raw = fs.readFileSync(FILE_PATH, 'utf-8');
        if (!raw.trim()) return { ...DEFAULT_SETTINGS };
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_SETTINGS, ...parsed };
    } catch (err) {
        console.error('[siteSettings] Ошибка чтения siteSettings.json:', err.message);
        return { ...DEFAULT_SETTINGS };
    }
}

function saveToDisk(settings) {
    ensureDataDir();
    fs.writeFileSync(FILE_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

let settings = loadFromDisk();

function getSettings() {
    return { ...settings };
}

function updateSettings(partial) {
    settings = { ...settings, ...partial };
    saveToDisk(settings);
    return getSettings();
}

module.exports = { getSettings, updateSettings };