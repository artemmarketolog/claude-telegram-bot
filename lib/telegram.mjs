import { execFile } from 'node:child_process';
import { openAsBlob } from 'node:fs';
import { constants, copyFile, chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const TEXT_LIMIT = 3900;
const runFile = promisify(execFile);
export const CLOUD_BOT_API = 'https://api.telegram.org';
export const LOCAL_BOT_API = 'http://127.0.0.1:8081';

// The cloud Bot API by default; an optional own Local Bot API server (large files) on loopback.
export function apiOptionsFromEnv(env = process.env) {
  const apiBase = (env.TELEGRAM_API_BASE || CLOUD_BOT_API).replace(/\/$/, '');
  let local = false;
  try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiBase).hostname); } catch {}
  if (env.TELEGRAM_API_LOCAL) local = env.TELEGRAM_API_LOCAL === '1';
  return { apiBase, local };
}
// Cloud Bot API limits: bots download files up to 20 MB and upload up to 50 MB.
export const CLOUD_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export const CLOUD_UPLOAD_LIMIT = 50 * 1024 * 1024;
const outgoing = /^(send|edit|copy|forward)/;

export class TelegramApiError extends Error {
  constructor(method, code, description, retryAfter = null) {
    super(`Telegram ${method}: ${description}`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// Split on codepoints, retaining every character and never cutting a surrogate pair.
export function splitText(value, limit = TEXT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Invalid text limit');
  const chars = Array.from(String(value));
  const parts = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + limit, chars.length);
    if (end < chars.length) {
      const min = start + Math.floor(limit / 2);
      for (const separator of ['\n', ' ']) {
        let boundary = end - 1;
        while (boundary >= min && chars[boundary] !== separator) boundary--;
        if (boundary >= min) { end = boundary + 1; break; }
      }
    }
    parts.push(chars.slice(start, end).join(''));
    start = end;
  }
  return parts;
}

function inlineHtml(text) {
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\[([^\]\n]+)\]\(([^\s)]+)\)|\*([^*\n]+)\*/g;
  let result = '';
  let previous = 0;
  for (const match of text.matchAll(pattern)) {
    result += escapeHtml(text.slice(previous, match.index));
    const [, code, bold, alternateBold, strike, label, url, italic] = match;
    if (code !== undefined) result += `<code>${escapeHtml(code)}</code>`;
    else if (bold !== undefined || alternateBold !== undefined) result += `<b>${escapeHtml(bold ?? alternateBold)}</b>`;
    else if (strike !== undefined) result += `<s>${escapeHtml(strike)}</s>`;
    else if (label !== undefined) {
      result += /^(https?:\/\/|tg:\/\/|mailto:)/i.test(url)
        ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
        : `${escapeHtml(label)} (${escapeHtml(url)})`;
    } else result += `<i>${escapeHtml(italic)}</i>`;
    previous = match.index + match[0].length;
  }
  return result + escapeHtml(text.slice(previous));
}

export function renderTelegramHtml(markdown) {
  const lines = String(markdown).replaceAll('\r\n', '\n').split('\n');
  const rendered = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s{0,3}(`{3,}|~{3,})([\w.+-]*)\s*$/);
    if (fence) {
      const body = [];
      const closing = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (++i < lines.length && !closing.test(lines[i])) body.push(lines[i]);
      const language = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : '';
      rendered.push(`<pre><code${language}>${escapeHtml(body.join('\n'))}</code></pre>`);
    } else {
      const heading = lines[i].match(/^#{1,6}\s+(.+?)\s*#*$/);
      if (heading) rendered.push(`<b>${inlineHtml(heading[1])}</b>`);
      else if (/^>\s?/.test(lines[i])) rendered.push(`<blockquote>${inlineHtml(lines[i].replace(/^>\s?/, ''))}</blockquote>`);
      else rendered.push(inlineHtml(lines[i].replace(/^([ \t]*)[-*+]\s+/, '$1• ')));
    }
  }
  return rendered.join('\n');
}

const plainHtml = html => String(html).replace(/<[^>]*>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"').replaceAll('&amp;', '&');

// A topic deleted by the user makes every send into it fail with this definite error.
export function topicGone(error) {
  return error instanceof TelegramApiError && error.code === 400
    && /message thread not found|thread not found|topic_deleted|topic_id_invalid/i.test(error.message);
}

function formattingError(error) {
  return error instanceof TelegramApiError && error.code === 400
    && /parse entities|unsupported start tag|can't find end|entity.*(?:invalid|offset)|unclosed/i.test(error.message);
}

function richParts(markdown) {
  let fence = null;
  let beginsLine = true;
  return splitText(markdown, 30000).map(part => {
    const prefix = fence ? `${fence}\n` : '';
    const lines = part.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i === 0 && !beginsLine) continue;
      const match = lines[i].match(/^\s{0,3}(`{3,}|~{3,})([\w.+-]{0,64})\s*$/);
      if (!match) continue;
      if (!fence) fence = match[1] + match[2];
      else if (match[1][0] === fence[0] && !match[2]) fence = null;
    }
    beginsLine = part.endsWith('\n');
    return prefix + part + (fence ? `\n${fence.match(/^[`~]+/)[0]}` : '');
  });
}

export class BotApi {
  #token;
  #base;
  #fetch;
  #local;
  #interval;
  #queues = new Map();
  #lastRequest = new Map();
  #controller = new AbortController();
  #richUnsupported = false;

  constructor({ token, apiBase = CLOUD_BOT_API, local = false, fetchImpl = fetch, minChatIntervalMs = 1100 }) {
    if (!token || typeof token !== 'string') throw new TypeError('Telegram token is required');
    let url;
    try { url = new URL(apiBase); } catch { throw new TypeError('Invalid Telegram API base'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash
      || !['https:', 'http:'].includes(url.protocol)
      || (url.protocol === 'http:' && !loopback) || (local && !loopback)) {
      throw new TypeError('Telegram API requires HTTPS or a trusted loopback local server');
    }
    this.#token = token;
    this.#base = url.href.replace(/\/$/, '');
    this.#fetch = fetchImpl;
    this.#local = local;
    this.#interval = minChatIntervalMs;
  }

  get local() { return this.#local; }

  #safe(value) {
    return String(value).replaceAll(this.#token, '[redacted]')
      .replaceAll(encodeURIComponent(this.#token), '[redacted]')
      .replace(/(?:https?:\/\/[^\s"']*\/)?(?:file\/)?bot\d+:[A-Za-z0-9_-]+[^\s"']*/g, '[Telegram URL]');
  }

  #signal(signal, timeoutMs) {
    return AbortSignal.any([this.#controller.signal, ...(signal ? [signal] : []),
      ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : [])]);
  }

  async request(method, params = {}, { signal } = {}) {
    if (!/^[a-z][a-z0-9]*$/i.test(method)) throw new TypeError('Invalid Telegram API method');
    const key = params.chat_id !== undefined && outgoing.test(method) ? String(params.chat_id) : null;
    // A file upload holds the chat's queue only for its pacing slot, not for the whole transfer:
    // all topics share one chat, and a long upload must not freeze cards and answers elsewhere.
    const multipart = params instanceof FormData;
    const run = async () => {
      const combined = this.#signal(signal);
      combined.throwIfAborted();
      if (key !== null) {
        const wait = this.#interval - (Date.now() - (this.#lastRequest.get(key) ?? 0));
        if (wait > 0) await delay(wait, undefined, { signal: combined });
        this.#lastRequest.set(key, Date.now());
      }
      return multipart && key !== null ? null : this.#perform(method, params, combined);
    };
    if (key === null) return run();
    const operation = (this.#queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
    this.#queues.set(key, operation);
    let result;
    try { result = await operation; }
    finally { if (this.#queues.get(key) === operation) this.#queues.delete(key); }
    return multipart ? this.#perform(method, params, this.#signal(signal)) : result;
  }

  async #perform(method, params, signal) {
    for (let attempt = 0; ; attempt++) {
      let response;
      let body;
      const timeoutMs = method === 'getUpdates' ? ((params.timeout ?? 25) + 15) * 1000
        : params instanceof FormData ? 30 * 60 * 1000 : 120000;
      const requestSignal = this.#signal(signal, timeoutMs);
      try {
        const multipart = params instanceof FormData;
        if (params.chat_id !== undefined && outgoing.test(method)) this.#lastRequest.set(String(params.chat_id), Date.now());
        response = await this.#fetch(`${this.#base}/bot${this.#token}/${method}`, {
          method: 'POST', redirect: 'error', signal: requestSignal,
          headers: multipart ? undefined : { 'content-type': 'application/json' },
          body: multipart ? params : JSON.stringify(params),
        });
        body = await response.json();
        if (!body || typeof body !== 'object') throw new Error('Invalid response');
      } catch {
        if (signal.aborted) throw new DOMException('Telegram request cancelled', 'AbortError');
        throw new TelegramApiError(method, 0, requestSignal.aborted ? 'request timed out' : 'network or invalid response');
      }
      if (response.ok && body.ok === true) return body.result;
      const retryAfter = body.parameters?.retry_after;
      if ((body.error_code === 429 || response.status === 429) && attempt < 8) {
        await delay((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1) * 1000, undefined, { signal });
        continue;
      }
      throw new TelegramApiError(method, body.error_code ?? response.status,
        this.#safe(body.description ?? 'request failed'), retryAfter ?? null);
    }
  }

  // `html: true` marks text that is already Telegram HTML; the fallback strips its tags.
  async #formatted(method, { html, ...params }, markdown, signal) {
    try { return await this.request(method, { ...params, text: html ? markdown : renderTelegramHtml(markdown), parse_mode: 'HTML' }, { signal }); }
    catch (error) {
      if (!formattingError(error)) throw error;
      return this.request(method, { ...params, text: html ? plainHtml(markdown) : markdown, parse_mode: undefined }, { signal });
    }
  }

  async sendText(chatId, markdown, { signal, ...options } = {}) {
    const parts = options.html ? [String(markdown)] : splitText(markdown);
    const messages = [];
    for (let i = 0; i < parts.length; i++) {
      messages.push(await this.#formatted('sendMessage', {
        ...options, chat_id: chatId, reply_markup: i === parts.length - 1 ? options.reply_markup : undefined,
      }, parts[i], signal));
    }
    return messages;
  }

  async sendAnswer(chatId, markdown, { signal, ...options } = {}) {
    if (this.#richUnsupported) return this.sendText(chatId, markdown, { ...options, signal });
    const parts = richParts(String(markdown));
    const messages = [];
    for (let i = 0; i < parts.length; i++) {
      const params = { ...options, chat_id: chatId, reply_markup: i === parts.length - 1 ? options.reply_markup : undefined };
      try {
        messages.push(await this.request('sendRichMessage', { ...params, rich_message: { markdown: parts[i] } }, { signal }));
      } catch (error) {
        const unsupported = error instanceof TelegramApiError && error.code === 404;
        const badFormat = error instanceof TelegramApiError && error.code === 400
          && /parse|rich|block|text|format|unsupported|method|entit|table|limit|length|too long|url|media/i.test(error.message);
        if (!unsupported && !badFormat) throw error;
        if (unsupported) this.#richUnsupported = true;
        messages.push(...await this.sendText(chatId, parts[i], { ...params, signal }));
      }
    }
    return messages;
  }

  async editText(chatId, messageId, markdown, { signal, ...options } = {}) {
    const chars = Array.from(String(markdown));
    const text = chars.length > TEXT_LIMIT && !options.html ? `${chars.slice(0, TEXT_LIMIT - 1).join('')}…` : String(markdown);
    try { return await this.#formatted('editMessageText', { ...options, chat_id: chatId, message_id: messageId }, text, signal); }
    catch (error) {
      if (error instanceof TelegramApiError && /message is not modified/i.test(error.message)) return null;
      throw error;
    }
  }

  async #upload(method, field, chatId, path, { signal, filename = basename(path), ...options }) {
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...options, chat_id: chatId })) {
      if (value !== undefined && value !== null) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    form.set(field, await openAsBlob(path), filename);
    // FormData does not expose chat_id as a property; attach it only for the queue selector.
    form.chat_id = chatId;
    return this.request(method, form, { signal });
  }

  sendDocument(chatId, path, options = {}) { return this.#upload('sendDocument', 'document', chatId, path, options); }
  sendPhoto(chatId, path, options = {}) { return this.#upload('sendPhoto', 'photo', chatId, path, options); }
  async sendVideo(chatId, path, options = {}) {
    // The Local Bot API does not infer playback geometry from the uploaded MP4: without width and height
    // the chat shows a 16:9 video as a square.
    if (![options.width, options.height, options.duration].every(value => Number.isFinite(value) && value > 0)) {
      let metadata;
      try {
        const { stdout } = await runFile('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
          '-select_streams', 'v:0', '-show_entries',
          'stream=width,height,sample_aspect_ratio,duration:stream_side_data=rotation:format=duration',
          '-of', 'json', path], { timeout: 10_000, maxBuffer: 1024 * 1024, signal: options.signal });
        const result = JSON.parse(stdout);
        const video = result.streams?.[0];
        let width = video?.width, height = video?.height;
        const [sarWidth, sarHeight] = String(video?.sample_aspect_ratio).split(':').map(Number);
        if (sarWidth > 0 && sarHeight > 0) width = Math.round(width * sarWidth / sarHeight);
        const rotation = video?.side_data_list?.find(data => Number.isFinite(data.rotation))?.rotation ?? 0;
        if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
        const duration = Math.ceil(Number(video?.duration) || Number(result.format?.duration));
        if (![width, height, duration].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid video metadata');
        metadata = { width, height, duration };
      } catch {
        if (options.signal?.aborted) options.signal.throwIfAborted();
        // No upload occurred: the gateway may safely fall back to a document.
        throw new TelegramApiError('sendVideo', 400, 'Video metadata unavailable; send as document');
      }
      options = { ...options, ...metadata };
    }
    return this.#upload('sendVideo', 'video', chatId, path, options);
  }
  sendAudio(chatId, path, options = {}) { return this.#upload('sendAudio', 'audio', chatId, path, options); }
  sendAnimation(chatId, path, options = {}) { return this.#upload('sendAnimation', 'animation', chatId, path, options); }
  sendVoice(chatId, path, options = {}) { return this.#upload('sendVoice', 'voice', chatId, path, options); }

  async download(fileId, destination, { signal, maxBytes = this.#local ? Infinity : CLOUD_DOWNLOAD_LIMIT } = {}) {
    const file = await this.request('getFile', { file_id: fileId }, { signal });
    const { file_path: sourcePath, ...metadata } = file;
    if (!file.file_path) throw new TelegramApiError('getFile', 0, 'file path missing');
    if (file.file_size > maxBytes) throw new TelegramApiError('getFile', 413, 'file exceeds download limit');
    try { await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); }
    catch { throw new TelegramApiError('download', 0, 'cannot create destination directory'); }
    if (isAbsolute(file.file_path)) {
      if (!this.#local) throw new TelegramApiError('getFile', 0, 'untrusted absolute file path');
      let copied = false;
      try {
        this.#signal(signal).throwIfAborted();
        const source = await lstat(sourcePath);
        if (!source.isFile() || source.size > maxBytes) throw new TelegramApiError('getFile', 413, 'file exceeds download limit or is not a regular file');
        await copyFile(sourcePath, destination, constants.COPYFILE_EXCL);
        copied = true;
        await chmod(destination, 0o600);
        return { path: destination, size: source.size, file: metadata };
      } catch (error) {
        if (copied) await unlink(destination).catch(() => {});
        if (error instanceof TelegramApiError) throw error;
        if (signal?.aborted || this.#controller.signal.aborted) throw new DOMException('Telegram download cancelled', 'AbortError');
        throw new TelegramApiError('download', error.code === 'EEXIST' ? 409 : 0,
          error.code === 'EEXIST' ? 'destination already exists' : 'local file transfer failed');
      }
    }
    if (file.file_path.split('/').some(part => part === '..') || /^[a-z]+:/i.test(file.file_path)) {
      throw new TelegramApiError('getFile', 0, 'invalid file path');
    }
    const combined = this.#signal(signal, 30 * 60 * 1000);
    let handle;
    let size = 0;
    try {
      const path = file.file_path.split('/').map(encodeURIComponent).join('/');
      const response = await this.#fetch(`${this.#base}/file/bot${this.#token}/${path}`, { signal: combined, redirect: 'error' });
      if (!response.ok || !response.body) throw new TelegramApiError('download', response.status, 'file download failed');
      if (Number(response.headers.get('content-length')) > maxBytes) throw new TelegramApiError('download', 413, 'file exceeds download limit');
      handle = await open(destination, 'wx', 0o600);
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(size > maxBytes ? new TelegramApiError('download', 413, 'file exceeds download limit') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limiter, handle.createWriteStream(), { signal: combined });
      return { path: destination, size, file: metadata };
    } catch (error) {
      if (handle) { await handle.close().catch(() => {}); await unlink(destination).catch(() => {}); }
      if (error instanceof TelegramApiError) throw error;
      if (signal?.aborted || this.#controller.signal.aborted) throw new DOMException('Telegram download cancelled', 'AbortError');
      if (error.code === 'EEXIST') throw new TelegramApiError('download', 409, 'destination already exists');
      throw new TelegramApiError('download', 0, combined.aborted ? 'download timed out' : 'file transfer failed');
    }
  }

  async poll(onUpdate, { offset = 0, onOffset = async () => {}, onError = async () => {}, signal, timeout = 25 } = {}) {
    const combined = this.#signal(signal);
    let backoff = 1000;
    while (!combined.aborted) {
      let updates;
      try {
        updates = await this.request('getUpdates', {
          offset, timeout, allowed_updates: ['message', 'callback_query'],
        }, { signal: combined });
        backoff = 1000;
      } catch (error) {
        if (combined.aborted) break;
        if (error instanceof TelegramApiError && [401, 403, 409].includes(error.code)) throw error;
        await onError(error);
        try { await delay(backoff, undefined, { signal: combined }); } catch { break; }
        backoff = Math.min(backoff * 2, 30000);
        continue;
      }
      for (const update of updates) {
        if (combined.aborted) break;
        if (update.update_id < offset) continue;
        // The app must durably enqueue work before returning. Its failures stop polling,
        // leaving the update unacknowledged rather than silently losing the message.
        await onUpdate(update);
        const next = update.update_id + 1;
        await onOffset(next);
        offset = next;
      }
    }
    return offset;
  }

  stop() { this.#controller.abort(); }
}
