const {
    joinVoiceChannel,
    getVoiceConnection,
    VoiceConnectionStatus,
    EndBehaviorType,
    entersState
} = require('@discordjs/voice');
const prism = require('prism-media');
const { pipeline } = require('stream');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

const RECORDINGS_DIR = path.join(__dirname, 'data', 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// 48 кГц, стерео, 16 бит = 192 байта на миллисекунду
const BYTES_PER_MS = 192;

const sessions = new Map(); // guildId -> session

function isRecording(guildId) {
    return sessions.has(guildId);
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegPath, ['-y', '-loglevel', 'error', ...args]);
        let err = '';
        p.stderr.on('data', d => (err += d));
        p.on('close', code => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg exit ${code}`))));
    });
}

function subscribeUser(session, userId) {
    if (session.active.has(userId)) return;

    let user = session.users.get(userId);
    if (!user) {
        user = {
            pcmPath: path.join(session.dir, `${userId}.pcm`),
            lastEnd: session.startedAt,
            name: userId
        };
        session.users.set(userId, user);
    }

    const opusStream = session.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 }
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const out = fs.createWriteStream(user.pcmPath, { flags: 'a' });

    // Заполняем паузу с прошлой реплики тишиной, чтобы дорожка не «съезжала»
    const gapMs = Date.now() - user.lastEnd;
    if (gapMs > 0) out.write(Buffer.alloc(Math.floor(gapMs * 48) * 4));

    session.active.add(userId);
    pipeline(opusStream, decoder, out, (err) => {
        session.active.delete(userId);
        user.lastEnd = Date.now();
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error(`Ошибка записи ${userId}:`, err.message);
        }
    });
}

async function startRecording(client, guildId, channelId) {
    if (sessions.has(guildId)) throw new Error('Запись уже идёт');

    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Гильдия не найдена');

    const channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isVoiceBased()) throw new Error('Канал не является голосовым');

    let connection = getVoiceConnection(guildId);
    if (connection && connection.joinConfig.channelId !== channel.id) {
        connection.destroy();
        connection = null;
    }
    if (!connection) {
        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false, // иначе бот ничего не услышит
            selfMute: true
        });
    }
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
        try { connection.destroy(); } catch {}
        throw new Error('Не удалось подключиться к голосовому каналу');
    }

    const startedAt = Date.now();
    const dir = path.join(RECORDINGS_DIR, new Date(startedAt).toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });

    const session = {
        dir,
        startedAt,
        channelName: channel.name,
        receiver: connection.receiver,
        users: new Map(),
        active: new Set(),
        onSpeakingStart: null
    };
    session.onSpeakingStart = (userId) => {
        const member = guild.members.cache.get(userId);
        if (member && member.user.bot) return;
        subscribeUser(session, userId);
        const u = session.users.get(userId);
        if (u && member) u.name = member.user.username;
    };
    connection.receiver.speaking.on('start', session.onSpeakingStart);
    sessions.set(guildId, session);

    // Уведомление участников о записи (не убирайте)
    try {
        await channel.send('🔴 **Начата запись голосового канала.** Если вы не согласны, покиньте канал.');
    } catch { /* у канала может не быть текстового чата */ }

    console.log(`🔴 Запись начата: ${channel.name} -> ${dir}`);
    return { dir: path.basename(dir) };
}

async function stopRecording(guildId) {
    const session = sessions.get(guildId);
    if (!session) throw new Error('Запись не идёт');

    session.receiver.speaking.off('start', session.onSpeakingStart);
    sessions.delete(guildId);

    const conn = getVoiceConnection(guildId);
    if (conn) { try { conn.destroy(); } catch {} }

    // Даём дописаться последним потокам
    await new Promise(r => setTimeout(r, 1500));

    const mp3Files = [];
    const pcmFiles = [];
    for (const [userId, user] of session.users) {
        if (!fs.existsSync(user.pcmPath) || fs.statSync(user.pcmPath).size === 0) continue;
        const safeName = user.name.replace(/[^\w.-]/g, '_');
        const mp3 = path.join(session.dir, `${safeName}_${userId}.mp3`);
        await runFfmpeg(['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', user.pcmPath, '-b:a', '128k', mp3]);
        mp3Files.push(path.basename(mp3));
        pcmFiles.push(user.pcmPath);
    }

    // Общий микс всех участников
    if (pcmFiles.length > 0) {
        const inputs = pcmFiles.flatMap(f => ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', f]);
        const mixArgs = pcmFiles.length > 1
            ? [...inputs, '-filter_complex', `amix=inputs=${pcmFiles.length}:duration=longest`, '-b:a', '128k', path.join(session.dir, 'mix.mp3')]
            : [...inputs, '-b:a', '128k', path.join(session.dir, 'mix.mp3')];
        await runFfmpeg(mixArgs);
        mp3Files.unshift('mix.mp3');
    }

    pcmFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
    console.log(`⏹️ Запись сохранена: ${session.dir}`);
    return { dir: path.basename(session.dir), files: mp3Files };
}

function listRecordings() {
    return fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({
            name: d.name,
            files: fs.readdirSync(path.join(RECORDINGS_DIR, d.name)).filter(f => f.endsWith('.mp3'))
        }))
        .sort((a, b) => b.name.localeCompare(a.name));
}

function getRecordingFile(dir, file) {
    const full = path.join(RECORDINGS_DIR, path.basename(dir), path.basename(file));
    return fs.existsSync(full) ? full : null;
}

function getRecordingStatus(guildId) {
    const session = sessions.get(guildId);
    if (!session) {
        return { recording: false };
    }

    return {
        recording: true,
        startTime: session.startedAt,
        duration: Math.round((Date.now() - session.startedAt) / 1000),
        channelName: session.channelName,
        participantsCount: session.users.size
    };
}

function deleteRecording(dir, file) {
    try {
        const filePath = path.join(RECORDINGS_DIR, path.basename(dir), path.basename(file));
        if (!fs.existsSync(filePath)) return false;

        fs.unlinkSync(filePath);
        return true;
    } catch (err) {
        console.error('Ошибка удаления записи:', err.message);
        return false;
    }
}

module.exports = {
    startRecording: (client, guildId, channelId) => startRecording(client, guildId, channelId),
    stopRecording: (guildId) => stopRecording(guildId),
    listRecordings,
    getRecordingFile,
    isRecording: (guildId) => isRecording(guildId),
    getRecordingStatus: (guildId) => getRecordingStatus(guildId),
    deleteRecording
};
