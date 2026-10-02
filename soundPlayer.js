const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    NoSubscriberBehavior,
    entersState,
    getVoiceConnection,
    generateDependencyReport
} = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const recorder = require('./recorder.js');

process.env.FFMPEG_PATH = require('ffmpeg-static');

const SOUNDS_BASE_DIR = path.join(__dirname, 'data', 'sounds');
const RECORDINGS_DIR = path.join(__dirname, 'data', 'recordings');
const ALLOWED_EXT = ['.mp3', '.wav', '.ogg', '.flac', '.m4a'];
const IDLE_DISCONNECT_MS = 15_000; // через сколько после окончания звука выйти из войса

if (!fs.existsSync(SOUNDS_BASE_DIR)) fs.mkdirSync(SOUNDS_BASE_DIR, { recursive: true });
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Получить директорию звуков для конкретного сервера
function getSoundsDir(guildId) {
    const dir = path.join(SOUNDS_BASE_DIR, guildId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Диагностика: покажет, есть ли DAVE/opus/sodium/ffmpeg
console.log('--- Voice dependency report ---\n' + generateDependencyReport());

// Безопасный путь к файлу (защита от ../)
function resolveSoundPath(guildId, filename) {
    const safe = path.basename(String(filename || ''));
    if (!ALLOWED_EXT.includes(path.extname(safe).toLowerCase())) return null;
    const soundsDir = getSoundsDir(guildId);
    return { safe, full: path.join(soundsDir, safe) };
}

// Безопасное уничтожение: не падает, если соединение уже уничтожено
function safeDestroy(conn) {
    try {
        if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
    } catch { /* уже уничтожено */ }
}

// Запросы на один сервер выполняются строго по очереди
const locks = new Map(); // guildId -> Promise
function withLock(guildId, fn) {
    const prev = locks.get(guildId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(guildId, next);
    return next;
}

function getSoundsList(guildId) {
    try {
        const soundsDir = getSoundsDir(guildId);
        return fs.readdirSync(soundsDir)
            .filter(f => ALLOWED_EXT.includes(path.extname(f).toLowerCase()))
            .map(f => {
                const full = path.join(soundsDir, f);
                return { name: f, path: full, size: fs.statSync(full).size };
            });
    } catch (err) {
        console.error('Ошибка чтения списка звуков:', err.message);
        return [];
    }
}

function deleteSound(guildId, filename) {
    try {
        const r = resolveSoundPath(guildId, filename);
        if (!r || !fs.existsSync(r.full)) return false;
        fs.unlinkSync(r.full);
        return true;
    } catch (err) {
        console.error('Ошибка удаления звука:', err.message);
        return false;
    }
}

// Состояние по гильдиям: один плеер на сервер
const guildState = new Map(); // guildId -> { player, idleTimer }
// Состояние записи: guildId -> { recording, stream, filename, startTime }
const recordingState = new Map();

function getState(guildId) {
    let state = guildState.get(guildId);
    if (!state) {
        const player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Play }
        });
        state = { player, idleTimer: null };

        player.on('error', err => console.error('Audio player error:', err.message));
        player.on(AudioPlayerStatus.Playing, () => {
            console.log('🎵 Воспроизведение началось');
            clearTimeout(state.idleTimer);
        });
        player.on(AudioPlayerStatus.Idle, () => {
            console.log('⏸️ Воспроизведение закончилось');
            clearTimeout(state.idleTimer);
            state.idleTimer = setTimeout(() => {
                if (recorder.isRecording(guildId)) return; // идёт запись, не выходим
                const conn = getVoiceConnection(guildId);
                safeDestroy(conn);
            }, IDLE_DISCONNECT_MS);
        });

        guildState.set(guildId, state);
    }
    return state;
}

async function ensureConnection(guild, channel) {
    let connection = getVoiceConnection(guild.id);

    if (connection && (
        connection.joinConfig.channelId !== channel.id ||
        connection.state.status === VoiceConnectionStatus.Destroyed ||
        connection.state.status === VoiceConnectionStatus.Disconnected
    )) {
        safeDestroy(connection);
        connection = null;
    }

    if (!connection) {
        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
            debug: true
        });

        const conn = connection;
        conn.on('stateChange', (o, n) => console.log(`Voice: ${o.status} -> ${n.status}`));
        conn.on('error', e => console.error('Voice connection error:', e.message));
        conn.on('debug', m => console.log('[voice debug]', m)); // покажет код закрытия (например 4017)

        conn.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(conn, VoiceConnectionStatus.Connecting, 5_000)
                ]);
            } catch {
                safeDestroy(conn);
            }
        });
    }

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
        const status = connection.state.status;
        safeDestroy(connection);
        throw new Error(
            `Не удалось подключиться к голосовому каналу (состояние: ${status}). ` +
            `Проверьте версии @discordjs/voice и @snazzah/davey.`
        );
    }
    return connection;
}

async function playSoundInChannel(client, guildId, channelId, soundFilename) {
    return withLock(guildId, async () => {
        try {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) throw new Error('Гильдия не найдена');

            const channel = await guild.channels.fetch(channelId);
            if (!channel) throw new Error('Канал не найден');
            if (!channel.isVoiceBased()) throw new Error('Канал не является голосовым');

            const me = guild.members.me || await guild.members.fetchMe();
            const perms = channel.permissionsFor(me);
            if (!perms.has('ViewChannel') || !perms.has('Connect')) throw new Error('У бота нет права CONNECT в этом канале');
            if (!perms.has('Speak')) throw new Error('У бота нет права SPEAK в этом канале');

            const r = resolveSoundPath(guildId, soundFilename);
            if (!r || !fs.existsSync(r.full)) throw new Error('Файл звука не найден');

            const connection = await ensureConnection(guild, channel);
            const state = getState(guild.id);
            clearTimeout(state.idleTimer);

            connection.subscribe(state.player);
            state.player.play(createAudioResource(r.full));

            console.log(`🔊 "${r.safe}" -> ${channel.name}`);
            return { success: true };
        } catch (err) {
            console.error('❌ Ошибка воспроизведения звука:', err.message);
            return { success: false, error: err.message };
        }
    });
}

function stopSoundInChannel(guildId, channelId) {
    try {
        const state = guildState.get(guildId);
        if (state) state.player.stop(true);
        // Если идёт запись, не уничтожаем соединение
        if (!recorder.isRecording(guildId)) {
            const conn = getVoiceConnection(guildId);
            safeDestroy(conn); // выходим из войса
        }
        console.log(`⏹️ Остановлено (канал ${channelId})`);
        return true;
    } catch (err) {
        console.error('Ошибка остановки:', err.message);
        return false;
    }
}

async function getVoiceChannels(client, guildId) {
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return [];
        return guild.channels.cache
            .filter(c => c.isVoiceBased())
            .map(c => ({ id: c.id, name: c.name, membersCount: c.members.size }));
    } catch (err) {
        console.error('Ошибка получения голосовых каналов:', err.message);
        return [];
    }
}

async function getChannelMembers(client, guildId, channelId) {
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return { error: 'Гильдия не найдена' };

        const channel = await guild.channels.fetch(channelId);
        if (!channel) return { error: 'Канал не найден' };
        if (!channel.isVoiceBased()) return { error: 'Канал не является голосовым' };

        const members = channel.members.map(member => ({
            id: member.id,
            username: member.user.username,
            displayName: member.displayName,
            avatar: member.user.displayAvatarURL({ size: 64 }),
            isBot: member.user.bot
        }));

        return { success: true, members, channelName: channel.name };
    } catch (err) {
        console.error('Ошибка получения участников канала:', err.message);
        return { error: err.message };
    }
}

// Начать запись голосового канала
async function startRecording(client, guildId, channelId) {
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return { success: false, error: 'Гильдия не найдена' };

        const channel = await guild.channels.fetch(channelId);
        if (!channel) return { success: false, error: 'Канал не найден' };
        if (!channel.isVoiceBased()) return { success: false, error: 'Канал не является голосовым' };

        // Проверяем, не идет ли уже запись
        if (recordingState.has(guildId)) {
            return { success: false, error: 'Запись уже идет' };
        }

        // Создаем имя файла с timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `recording_${timestamp}.mp3`;
        const filepath = path.join(RECORDINGS_DIR, filename);

        // Подключаемся к каналу для записи
        const connection = await ensureConnection(guild, channel);

        // Создаем receiver для захвата аудио
        const receiver = connection.receiver;

        // Создаем поток записи
        const recording = {
            connection,
            receiver,
            filename,
            filepath,
            startTime: Date.now(),
            streams: new Map() // userId -> writable stream
        };

        // Подписываемся на аудио поток каждого участника
        channel.members.forEach(member => {
            if (member.user.bot) return; // Не записываем ботов

            const audioStream = receiver.subscribe(member.user.id, {
                end: {
                    behavior: 'manual'
                }
            });

            if (audioStream) {
                // Создаем отдельный файл для каждого пользователя
                const userFilename = `recording_${timestamp}_${member.user.username}.opus`;
                const userFilepath = path.join(RECORDINGS_DIR, userFilename);
                const writeStream = fs.createWriteStream(userFilepath);

                audioStream.pipe(writeStream);
                recording.streams.set(member.user.id, {
                    stream: audioStream,
                    writeStream,
                    filepath: userFilepath,
                    username: member.user.username
                });

                console.log(`🎙️ Начата запись для ${member.user.username}`);
            }
        });

        recordingState.set(guildId, recording);

        console.log(`🎙️ Запись начата в канале ${channel.name}`);
        return { success: true, filename };
    } catch (err) {
        console.error('Ошибка начала записи:', err.message);
        return { success: false, error: err.message };
    }
}

// Остановить запись
async function stopRecording(guildId) {
    try {
        const recording = recordingState.get(guildId);
        if (!recording) {
            return { success: false, error: 'Нет активной записи' };
        }

        const duration = Date.now() - recording.startTime;

        // Закрываем все потоки
        recording.streams.forEach((data, userId) => {
            try {
                data.stream.destroy();
                data.writeStream.end();
                console.log(`🎙️ Запись остановлена для ${data.username}`);
            } catch (err) {
                console.error(`Ошибка закрытия потока для ${data.username}:`, err.message);
            }
        });

        // Получаем список записанных файлов
        const recordedFiles = Array.from(recording.streams.values()).map(data => ({
            filename: path.basename(data.filepath),
            username: data.username,
            path: data.filepath
        }));

        recordingState.delete(guildId);

        console.log(`🎙️ Запись остановлена. Длительность: ${Math.round(duration / 1000)}с`);

        return {
            success: true,
            duration: Math.round(duration / 1000),
            files: recordedFiles
        };
    } catch (err) {
        console.error('Ошибка остановки записи:', err.message);
        return { success: false, error: err.message };
    }
}

// Получить статус записи
function getRecordingStatus(guildId) {
    const recording = recordingState.get(guildId);
    if (!recording) {
        return { recording: false };
    }

    return {
        recording: true,
        startTime: recording.startTime,
        duration: Math.round((Date.now() - recording.startTime) / 1000),
        filename: recording.filename,
        participantsCount: recording.streams.size
    };
}

// Получить список записей
function getRecordingsList() {
    try {
        const files = fs.readdirSync(RECORDINGS_DIR)
            .filter(f => ['.opus', '.mp3', '.wav'].includes(path.extname(f).toLowerCase()))
            .map(f => {
                const full = path.join(RECORDINGS_DIR, f);
                const stats = fs.statSync(full);
                return {
                    name: f,
                    path: full,
                    size: stats.size,
                    created: stats.birthtime
                };
            })
            .sort((a, b) => b.created - a.created);

        return files;
    } catch (err) {
        console.error('Ошибка чтения списка записей:', err.message);
        return [];
    }
}

// Удалить запись
function deleteRecording(filename) {
    try {
        const filepath = path.join(RECORDINGS_DIR, filename);
        if (!fs.existsSync(filepath)) return false;
        fs.unlinkSync(filepath);
        return true;
    } catch (err) {
        console.error('Ошибка удаления записи:', err.message);
        return false;
    }
}

// Конвертировать opus в mp3
async function convertToMp3(filename) {
    return new Promise((resolve, reject) => {
        try {
            const inputPath = path.join(RECORDINGS_DIR, filename);
            const baseName = path.parse(filename).name;
            const outputFilename = `${baseName}.mp3`;
            const outputPath = path.join(RECORDINGS_DIR, outputFilename);

            console.log(`[Конвертация] Входной файл: ${inputPath}`);
            console.log(`[Конвертация] Выходной файл: ${outputPath}`);

            if (!fs.existsSync(inputPath)) {
                return reject(new Error('Файл не найден'));
            }

            // Проверяем размер файла
            const stats = fs.statSync(inputPath);
            console.log(`[Конвертация] Размер файла: ${stats.size} bytes`);

            if (stats.size === 0) {
                return reject(new Error('Файл пустой - возможно, в канале не было аудио'));
            }

            // Если mp3 уже существует, возвращаем его
            if (fs.existsSync(outputPath)) {
                console.log(`[Конвертация] MP3 уже существует, пропускаем`);
                return resolve({ success: true, filename: outputFilename });
            }

            const ffmpegPath = require('ffmpeg-static');
            console.log(`[Конвертация] FFmpeg путь: ${ffmpegPath}`);

            // Проверяем что FFmpeg существует
            if (!fs.existsSync(ffmpegPath)) {
                return reject(new Error('FFmpeg не найден'));
            }

            // Используем более совместимые параметры для opus
            const args = [
                '-i', inputPath,
                '-c:a', 'libmp3lame',
                '-b:a', '192k',
                '-ar', '48000',
                '-ac', '2',
                '-map_metadata', '-1',
                '-y',
                outputPath
            ];

            console.log(`[Конвертация] Аргументы FFmpeg:`, args.join(' '));

            const ffmpeg = spawn(ffmpegPath, args, {
                windowsHide: true // Скрыть окно на Windows
            });

            let stderrOutput = '';

            ffmpeg.stderr.on('data', (data) => {
                stderrOutput += data.toString();
                console.log('[FFmpeg stderr]', data.toString());
            });

            ffmpeg.stdout.on('data', (data) => {
                console.log('[FFmpeg stdout]', data.toString());
            });

            // Таймаут на 30 секунд
            const timeout = setTimeout(() => {
                ffmpeg.kill();
                reject(new Error('Таймаут конвертации (30 секунд)'));
            }, 30000);

            ffmpeg.on('close', (code) => {
                clearTimeout(timeout);
                console.log(`[FFmpeg] Завершено с кодом: ${code}`);
                console.log(`[FFmpeg] Полный вывод stderr:`, stderrOutput);

                if (code === 0) {
                    if (fs.existsSync(outputPath)) {
                        const outputStats = fs.statSync(outputPath);
                        console.log(`✅ Конвертация завершена: ${filename} -> ${outputFilename} (${outputStats.size} bytes)`);
                        resolve({ success: true, filename: outputFilename });
                    } else {
                        reject(new Error('FFmpeg завершился успешно, но выходной файл не создан'));
                    }
                } else {
                    reject(new Error(`FFmpeg завершился с кодом ${code}. Подробности: ${stderrOutput}`));
                }
            });

            ffmpeg.on('error', (err) => {
                clearTimeout(timeout);
                console.error('[FFmpeg error]', err);
                reject(new Error(`Ошибка запуска FFmpeg: ${err.message}`));
            });
        } catch (err) {
            console.error('[Конвертация] Ошибка:', err);
            reject(err);
        }
    });
}

module.exports = function (client) {
    return {
        getSoundsList: (guildId) => getSoundsList(guildId),
        deleteSound: (guildId, filename) => deleteSound(guildId, filename),
        playSoundInChannel: (guildId, channelId, soundFilename) => playSoundInChannel(client, guildId, channelId, soundFilename),
        stopSoundInChannel: (guildId, channelId) => stopSoundInChannel(guildId, channelId),
        getVoiceChannels: (guildId) => getVoiceChannels(client, guildId),
        getChannelMembers: (guildId, channelId) => getChannelMembers(client, guildId, channelId),
        startRecording: (guildId, channelId) => startRecording(client, guildId, channelId),
        stopRecording: (guildId) => stopRecording(guildId),
        getRecordingStatus: (guildId) => getRecordingStatus(guildId),
        getRecordingsList,
        deleteRecording,
        convertToMp3
    };
};
