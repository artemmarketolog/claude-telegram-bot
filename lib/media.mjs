import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class MediaError extends Error {
  constructor(message) { super(message); this.name = 'MediaError'; }
}

export function safeFilename(name = 'file') {
  let safe = String(name).replaceAll('\\', '/').split('/').at(-1)
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[^\p{L}\p{N}_.() -]/gu, '_').replace(/^\.+/, '').trim();
  if (!safe) safe = 'file';
  const suffix = extname(safe).slice(0, 16);
  let stem = safe.slice(0, safe.length - suffix.length);
  while (Buffer.byteLength(stem + suffix) > 160) stem = Array.from(stem).slice(0, -1).join('');
  return stem + suffix;
}

export function attachmentFromMessage(message) {
  if (message.photo?.length) {
    const photo = [...message.photo].sort((a, b) => (b.file_size ?? b.width * b.height) - (a.file_size ?? a.width * a.height))[0];
    return { ...photo, kind: 'photo', file_name: 'photo.jpg', mime_type: 'image/jpeg' };
  }
  for (const kind of ['document', 'voice', 'audio', 'video', 'video_note', 'animation', 'sticker']) {
    const file = message[kind];
    if (!file?.file_id) continue;
    const extension = kind === 'voice' ? 'ogg' : kind === 'video_note' || kind === 'video' || kind === 'animation' ? 'mp4'
      : kind === 'sticker' ? (file.is_video ? 'webm' : file.is_animated ? 'tgs' : 'webp') : kind === 'audio' ? 'mp3' : 'bin';
    return { ...file, kind, file_name: file.file_name ?? `${kind}.${extension}` };
  }
  return null;
}

async function imageFormat(path) {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes, 0, 12, 0);
    if (bytesRead >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
  } finally { await handle.close(); }
}

async function ffmpeg(args, signal) {
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
      stdio: 'ignore', signal,
    });
    child.once('error', () => reject(new MediaError(signal?.aborted ? 'Обработка аудио остановлена.' : 'Не удалось запустить ffmpeg.')));
    child.once('close', code => code === 0 ? resolve() : reject(new MediaError(signal?.aborted
      ? 'Обработка аудио остановлена.' : 'Не удалось прочитать аудио в этом файле.')));
  });
}

// Speech: OpenAI when OPENAI_API_KEY is set (recommended), otherwise a local whisper.cpp model
// (free, offline) when LOCAL_STT_MODEL points to it.
export async function transcribeAudio(path, {
  openaiKey = process.env.OPENAI_API_KEY, localModel = process.env.LOCAL_STT_MODEL, ...options
} = {}) {
  if (openaiKey) return transcribeOpenAI(path, { openaiKey, ...options });
  if (localModel) return transcribeLocal(path, { localModel, ...options });
  throw new MediaError('Расшифровка голосовых не настроена: добавь OPENAI_API_KEY или локальную модель (docs/VOICE.md). Оригинал сохранён.');
}

function run(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.once('error', error => reject(error));
    child.once('close', code => code === 0 ? resolve() : reject(Object.assign(new Error(stderr.trim() || `exit ${code}`), { exitCode: code })));
  });
}

// whisper.cpp runs two model families with the same flags for model, input, threads and text output:
// Parakeet (parakeet-cli, fast, detects the language itself) and Whisper (whisper-cli).
export async function transcribeLocal(path, {
  localModel, parakeet = /parakeet/i.test(basename(localModel)),
  localCli = process.env.LOCAL_STT_CLI || (parakeet ? 'parakeet-cli' : 'whisper-cli'), language = process.env.LOCAL_STT_LANGUAGE || 'auto',
  threads = Number(process.env.LOCAL_STT_THREADS) || Math.max(1, Math.min(8, availableParallelism() - 1)),
  signal, onStatus = async () => {},
} = {}) {
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60 * 60 * 1000)]);
  const temporary = await mkdtemp(join(dirname(path), '.speech-'));
  try {
    await onStatus('Подготавливаю аудио');
    await ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le', join(temporary, 'audio.wav')], combined);
    await onStatus('Распознаю аудио локально');
    try {
      await run(localCli, ['-m', localModel, '-f', join(temporary, 'audio.wav'), '-t', String(threads),
        ...(parakeet ? [] : ['-l', language, '-nt']), '-np', '-otxt', '-of', join(temporary, 'text')], combined);
    } catch (error) {
      if (combined.aborted) throw new MediaError('Распознавание аудио остановлено.');
      throw new MediaError(error.code === 'ENOENT' ? `Локальная модель речи не найдена (${basename(localCli)}). Оригинал сохранён.`
        : 'Локальная модель не смогла распознать аудио. Оригинал сохранён.');
    }
    return (await readFile(join(temporary, 'text.txt'), 'utf8')).replace(/\s*\n\s*/g, ' ').trim();
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function transcribeOpenAI(path, {
  openaiKey, model = 'whisper-1', signal,
  fetchImpl = fetch, onStatus = async () => {}, segmentSeconds = 180,
} = {}) {
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60 * 60 * 1000)]);
  const temporary = await mkdtemp(join(dirname(path), '.speech-'));
  try {
    await onStatus('Подготавливаю аудио');
    // Three-minute chunks stay below the 25 MB upload and 2000 output-token limits.
    await ffmpeg(['-protocol_whitelist', 'file,pipe', '-i', path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'segment', '-segment_time', String(segmentSeconds),
      '-reset_timestamps', '1', join(temporary, '%05d.mp3')], combined);
    const chunks = (await readdir(temporary)).filter(name => name.endsWith('.mp3')).sort();
    if (!chunks.length) throw new MediaError('В файле не найдена аудиодорожка.');
    const transcripts = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = join(temporary, chunks[i]);
      if ((await stat(chunk)).size > 25_000_000) throw new MediaError('Часть аудио превышает лимит сервиса распознавания.');
      await onStatus(`Распознаю аудио · ${i + 1}/${chunks.length}`);
      const form = new FormData();
      form.set('file', await openAsBlob(chunk, { type: 'audio/mpeg' }), basename(chunk));
      form.set('model', model);
      form.set('response_format', 'json');
      if (transcripts.length) form.set('prompt', transcripts.at(-1).slice(-1000));
      let text;
      for (let attempt = 0; ; attempt++) {
        let response;
        try {
          response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST', headers: { Authorization: `Bearer ${openaiKey}` }, body: form,
            signal: AbortSignal.any([combined, AbortSignal.timeout(10 * 60 * 1000)]), redirect: 'error',
          });
        } catch {
          throw new MediaError(combined.aborted ? 'Распознавание аудио остановлено.' : 'Сервис распознавания не ответил. Оригинал сохранён.');
        }
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await response.body?.cancel();
          await delay((retryAfter > 0 ? retryAfter : 2 ** (attempt + 1)) * 1000, undefined, { signal: combined });
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new MediaError(response.status === 401 ? 'Сервис распознавания отклонил ключ OpenAI.'
            : `Сервис распознавания вернул ошибку ${response.status}. Оригинал сохранён.`);
        }
        let result;
        try { result = await response.json(); } catch { throw new MediaError('Сервис распознавания вернул некорректный ответ.'); }
        if (typeof result.text !== 'string') throw new MediaError('Сервис распознавания не вернул текст.');
        text = result.text.trim();
        break;
      }
      transcripts.push(text);
    }
    return transcripts.filter(Boolean).join('\n\n');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function saveManifest(path, manifest) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export function incomingDownloadBudget(freeBytes, fileSize = 0) {
  const reserve = 512 * 1024 * 1024;
  const available = Math.floor(freeBytes - reserve);
  const size = Number.isFinite(fileSize) && fileSize > 0 ? fileSize : 0;
  if (available <= 0 || size * 2 > available) {
    throw new MediaError('На сервере недостаточно свободного места для файла и его копии. Вложение не скачано.');
  }
  return Math.floor(available / 2);
}

export async function prepareMedia(message, {
  api, threadId, filesRoot, openaiKey = process.env.OPENAI_API_KEY, localModel = process.env.LOCAL_STT_MODEL,
  signal, onStatus = async () => {}, transcribe = true, fetchImpl = fetch,
} = {}) {
  const file = attachmentFromMessage(message);
  const caption = message.text ?? message.caption ?? '';
  if (!file) return { inputs: caption ? [{ type: 'text', text: caption }] : [], attachments: [], warnings: [] };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId ?? '')) throw new MediaError('Некорректный идентификатор чата.');
  const dir = join(filesRoot, threadId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = safeFilename(file.file_name);
  const path = join(dir, `${randomUUID()}__${name}`);
  await onStatus('Сохраняю вложение');
  const storage = await statfs(dir);
  const maxBytes = incomingDownloadBudget(storage.bavail * storage.bsize, file.file_size);
  let downloaded;
  try { downloaded = await api.download(file.file_id, path, { signal, maxBytes }); }
  catch (error) {
    if (!api.local && (error.code === 413 || /too big/i.test(error.message ?? ''))) {
      throw new MediaError('Файл больше 20 МБ: облачный Telegram Bot API не отдаёт ботам такие файлы. Пришли файл поменьше или подключи свой Local Bot API (docs/LOCAL-BOT-API.md).');
    }
    throw error;
  }
  const attachment = {
    path, name, fileId: file.file_id, fileUniqueId: file.file_unique_id,
    mimeType: file.mime_type ?? 'application/octet-stream', size: downloaded.size, kind: file.kind,
    messageId: message.message_id, mediaGroupId: message.media_group_id, savedAt: new Date().toISOString(),
  };
  const manifestPath = `${path}.json`;
  await saveManifest(manifestPath, attachment);
  const warnings = [];
  let transcript;
  const isAudio = ['voice', 'audio', 'video_note'].includes(file.kind)
    || /^audio\//i.test(file.mime_type ?? '') || /\.(?:mp3|ogg|opus|wav|m4a|flac|aac|wma)$/i.test(name);
  if (isAudio && transcribe) {
    try {
      transcript = await transcribeAudio(path, { openaiKey, localModel, signal, fetchImpl, onStatus });
      attachment.transcriptPath = `${path}.txt`;
      await writeFile(attachment.transcriptPath, transcript, { mode: 0o600, flag: 'wx' });
      if (!transcript) warnings.push('Речь в аудио не распознана. Оригинал сохранён.');
    } catch (error) {
      if (signal?.aborted) throw new MediaError('Обработка вложения остановлена. Оригинал сохранён.');
      warnings.push(error instanceof MediaError ? error.message : 'Не удалось распознать аудио. Оригинал сохранён.');
    }
    attachment.transcriptionWarning = warnings[0];
    await saveManifest(manifestPath, attachment);
  }
  const text = [caption, transcript === undefined ? null : `Расшифровка аудио пользователя:\n${transcript}`,
    `Вложение пользователя сохранено на сервере. Метаданные файла:\n${JSON.stringify({ path, name, kind: file.kind, size: attachment.size, mimeType: attachment.mimeType })}`,
    ...warnings].filter(Boolean).join('\n\n');
  const inputs = [{ type: 'text', text }];
  if (await imageFormat(path)) inputs.push({ type: 'localImage', path });
  return { inputs, attachments: [attachment], warnings, transcript };
}
