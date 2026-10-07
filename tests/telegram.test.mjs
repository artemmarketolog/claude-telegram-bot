import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotApi, CLOUD_BOT_API, LOCAL_BOT_API, TelegramApiError, apiOptionsFromEnv, renderTelegramHtml, splitText, topicGone } from '../lib/telegram.mjs';

const TOKEN = '123456:test-secret-token';
const json = result => Response.json({ ok: true, result });
// Most transport tests exercise the cloud mode explicitly; the default is the Local Bot API.
const api = (fetchImpl, extra = {}) => new BotApi({ token: TOKEN, minChatIntervalMs: 0, fetchImpl, apiBase: 'https://api.telegram.org', local: false, ...extra });
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'codex-telegram-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('the cloud Bot API is the default; a loopback base URL means an own Local Bot API', async () => {
  const urls = [];
  const bot = new BotApi({ token: TOKEN, minChatIntervalMs: 0, fetchImpl: async url => { urls.push(url); return json({ id: 1 }); } });
  await bot.request('getMe');
  assert.equal(bot.local, false);
  assert.equal(urls[0], `${CLOUD_BOT_API}/bot${TOKEN}/getMe`);
  assert.deepEqual(apiOptionsFromEnv({}), { apiBase: CLOUD_BOT_API, local: false });
  assert.deepEqual(apiOptionsFromEnv({ TELEGRAM_API_BASE: LOCAL_BOT_API }), { apiBase: LOCAL_BOT_API, local: true });
  assert.deepEqual(apiOptionsFromEnv({ TELEGRAM_API_BASE: 'http://localhost:8081/' }), { apiBase: 'http://localhost:8081', local: true });
  assert.deepEqual(apiOptionsFromEnv({ TELEGRAM_API_BASE: 'https://api.telegram.org' }), { apiBase: 'https://api.telegram.org', local: false });
  assert.throws(() => new BotApi({ token: TOKEN, apiBase: 'https://example.com', local: true }), /loopback/);
});

test('splitting preserves Unicode and all whitespace within the character limit', () => {
  const text = 'Начало 🧑🏽‍💻\n' + '🚀'.repeat(4100) + '\nКонец & <tag>';
  const parts = splitText(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(Array.from(part).length <= 3900);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part));
  }
});

test('rendering escapes hostile HTML and supports headings, code and links', () => {
  const rendered = renderTelegramHtml('# Заголовок\n- **важно** <script>&\n```js\na < b && c\n```\n[link](https://example.com/?a=1&b=2)\n[bad](javascript:alert)');
  assert.match(rendered, /<b>Заголовок<\/b>/);
  assert.match(rendered, /• <b>важно<\/b> &lt;script&gt;&amp;/);
  assert.match(rendered, /<pre><code class="language-js">a &lt; b &amp;&amp; c<\/code><\/pre>/);
  assert.match(rendered, /href="https:\/\/example.com\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(rendered, /href="javascript:/);
});

test('HTML parse error falls back to raw text and retains the keyboard', async () => {
  const calls = [];
  const keyboard = { inline_keyboard: [[{ text: 'Чаты', callback_data: 'chats' }]] };
  const bot = api(async (url, options) => {
    calls.push(JSON.parse(options.body));
    return calls.length === 1
      ? Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 })
      : json({ message_id: 1 });
  });
  assert.deepEqual(await bot.sendText(42, '**Ответ**', { reply_markup: keyboard }), [{ message_id: 1 }]);
  assert.equal(calls[0].parse_mode, 'HTML');
  assert.equal(calls[1].text, '**Ответ**');
  assert.equal(calls[1].parse_mode, undefined);
  assert.deepEqual(calls[1].reply_markup, keyboard);
});

test('long replies retain controls only on the final message', async () => {
  const calls = [];
  const bot = api(async (url, options) => { calls.push(JSON.parse(options.body)); return json({ message_id: calls.length }); });
  await bot.sendText(42, 'А'.repeat(4000), { reply_markup: { inline_keyboard: [] } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].reply_markup, undefined);
  assert.deepEqual(calls[1].reply_markup, { inline_keyboard: [] });
});

test('prepared HTML is sent as-is, falls back to plain text, and deleted topics are recognized', async () => {
  const calls = [];
  const bot = api(async (url, options) => {
    calls.push(JSON.parse(options.body));
    return calls.length === 1
      ? Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 })
      : json({ message_id: 3 });
  });
  await bot.editText(42, 3, '🎙 <blockquote expandable>a &lt; b</blockquote>', { html: true });
  assert.equal(calls[0].text, '🎙 <blockquote expandable>a &lt; b</blockquote>');
  assert.equal(calls[0].parse_mode, 'HTML');
  assert.equal(calls[1].text, '🎙 a < b');
  assert.equal(calls[1].html, undefined);
  assert.equal(topicGone(new TelegramApiError('sendMessage', 400, 'Bad Request: message thread not found')), true);
  assert.equal(topicGone(new TelegramApiError('sendMessage', 400, 'Bad Request: chat not found')), false);
  assert.equal(topicGone(new TelegramApiError('sendMessage', 0, 'message thread not found')), false);
});

test('not-modified edit is a benign no-op', async () => {
  const bot = api(async () => Response.json({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }, { status: 400 }));
  assert.equal(await bot.editText(42, 1, 'Status'), null);
});

test('final answers use rich Markdown for a table and code while retaining the keyboard', async () => {
  const markdown = '| Name | Result |\n| --- | --- |\n| Test | Passed |\n\n```js\nconsole.log("ready");\n```';
  const keyboard = { inline_keyboard: [[{ text: 'Чаты', callback_data: 'chats' }]] };
  const bot = api(async (url, options) => {
    assert.ok(url.endsWith('/sendRichMessage'));
    const body = JSON.parse(options.body);
    assert.equal(body.rich_message.markdown, markdown);
    assert.deepEqual(body.reply_markup, keyboard);
    return json({ message_id: 9, rich_message: { blocks: [] } });
  });
  const messages = await bot.sendAnswer(42, markdown, { reply_markup: keyboard });
  assert.equal(messages[0].message_id, 9);
});

test('unsupported rich API falls back to readable regular messages and remembers capability', async () => {
  const methods = [];
  const bot = api(async (url, options) => {
    const method = url.split('/').at(-1);
    methods.push(method);
    if (method === 'sendRichMessage') return Response.json({ ok: false, error_code: 404, description: 'Not Found' }, { status: 404 });
    assert.match(JSON.parse(options.body).text, /<b>Ответ<\/b>/);
    return json({ message_id: methods.length });
  });
  await bot.sendAnswer(42, '**Ответ**');
  await bot.sendAnswer(42, '**Ответ**');
  assert.deepEqual(methods, ['sendRichMessage', 'sendMessage', 'sendMessage']);
});

test('rich format errors fall back, while network errors do not risk duplicate final answers', async () => {
  const calls = [];
  const bot = api(async url => {
    calls.push(url.split('/').at(-1));
    return calls.length === 1
      ? Response.json({ ok: false, error_code: 400, description: 'Too many rich blocks' }, { status: 400 })
      : json({ message_id: 2 });
  });
  await bot.sendAnswer(42, 'content');
  assert.deepEqual(calls, ['sendRichMessage', 'sendMessage']);
  let attempts = 0;
  const disconnected = api(async () => { attempts++; throw new Error('connection lost'); });
  await assert.rejects(disconnected.sendAnswer(42, 'content'), TelegramApiError);
  assert.equal(attempts, 1);
});

test('long rich code is split below the published text limit with fences retained', async () => {
  const parts = [];
  const bot = api(async (url, options) => { parts.push(JSON.parse(options.body).rich_message.markdown); return json({ message_id: parts.length }); });
  await bot.sendAnswer(42, '```js\n' + 'x'.repeat(34000) + '\n```');
  assert.equal(parts.length, 2);
  for (const part of parts) {
    assert.ok(Array.from(part).length <= 32768);
    assert.ok(part.startsWith('```js\n'));
    assert.ok(part.endsWith('\n```'));
  }
});

test('429 respects retry_after and sends once successfully', async () => {
  let calls = 0;
  const bot = api(async () => ++calls === 1
    ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0.005 } }, { status: 429 })
    : json(true));
  assert.equal(await bot.request('answerCallbackQuery', { callback_query_id: 'x' }), true);
  assert.equal(calls, 2);
});

test('per-chat throttling serializes sends and edits without blocking another chat', async () => {
  const calls = [];
  const bot = api(async (url, options) => { calls.push({ time: Date.now(), ...JSON.parse(options.body) }); return json(true); }, { minChatIntervalMs: 30 });
  await Promise.all([
    bot.request('sendMessage', { chat_id: 1, text: 'first' }),
    bot.request('editMessageText', { chat_id: 1, text: 'second' }),
    bot.request('sendMessage', { chat_id: 2, text: 'independent' }),
  ]);
  assert.equal(calls[2].text, 'second');
  assert.ok(calls[2].time - calls[0].time >= 25);
});

test('network and Telegram errors never expose token-bearing URLs or paths', async () => {
  const failingNetwork = api(async () => { throw new Error(`failed https://api.telegram.org/bot${TOKEN}/getMe`); });
  await assert.rejects(failingNetwork.request('getMe'), error => error instanceof TelegramApiError && !error.message.includes(TOKEN));
  const failingApi = api(async () => Response.json({ ok: false, error_code: 400, description: `/srv/${TOKEN}/file ${encodeURIComponent(TOKEN)}` }, { status: 400 }));
  await assert.rejects(failingApi.request('getMe'), error => !error.message.includes(TOKEN) && !error.message.includes(encodeURIComponent(TOKEN)));
});

test('upload passes native multipart file and serialized inline keyboard', async t => {
  const path = join(await directory(t), 'résumé.txt');
  await writeFile(path, 'данные');
  const bot = api(async (url, options) => {
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('chat_id'), '42');
    assert.equal(await options.body.get('document').text(), 'данные');
    assert.equal(options.body.get('document').name, 'résumé.txt');
    assert.deepEqual(JSON.parse(options.body.get('reply_markup')), { inline_keyboard: [] });
    return json({ message_id: 3 });
  });
  assert.deepEqual(await bot.sendDocument(42, path, { reply_markup: { inline_keyboard: [] } }), { message_id: 3 });
});

test('cloud downloads stream bytes, use private permissions and omit file_path metadata', async t => {
  const destination = join(await directory(t), 'attachment.txt');
  const bot = api(async url => url.endsWith('/getFile')
    ? json({ file_path: 'documents/file.txt', file_id: 'id', file_size: 4 })
    : new Response('test'));
  const result = await bot.download('id', destination);
  assert.equal(await readFile(destination, 'utf8'), 'test');
  assert.equal(result.size, 4);
  assert.equal(result.file.file_path, undefined);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
});

test('video upload uses the player method with native multipart media and playback metadata', async t => {
  const path = join(await directory(t), 'result.mp4');
  await writeFile(path, 'video-fixture');
  const bot = api(async (url, options) => {
    assert.ok(url.endsWith('/sendVideo'));
    assert.equal(await options.body.get('video').text(), 'video-fixture');
    assert.equal(options.body.get('video').name, 'result.mp4');
    assert.equal(options.body.get('supports_streaming'), 'true');
    assert.equal(options.body.get('duration'), '12');
    assert.equal(options.body.get('caption'), 'Результат');
    assert.equal(options.body.get('document'), null);
    return json({ message_id: 4, video: { file_id: 'native-video' } });
  });
  const result = await bot.sendVideo(42, path, { supports_streaming: true, duration: 12, width: 1920, height: 1080, caption: 'Результат' });
  assert.equal(result.video.file_id, 'native-video');
});

test('video uploads infer landscape, portrait and square playback geometry from real MP4s', async t => {
  const dir = await directory(t);
  const run = promisify(execFile);
  const shapes = [['landscape', 320, 180], ['portrait', 180, 320], ['square', 240, 240]];
  for (const [name, width, height] of shapes) {
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=blue:s=${width}x${height}:r=5`,
      '-t', '1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', join(dir, `${name}.mp4`)]);
  }
  for (const [name, width, height] of shapes) {
    const path = join(dir, `${name}.mp4`);
    let upload;
    const bot = api(async (url, options) => { upload = { url, body: options.body }; return json({ message_id: 4 }); });
    await bot.sendVideo(42, path, { supports_streaming: true, message_thread_id: 10 });
    assert.ok(upload.url.endsWith('/sendVideo'));
    assert.equal(upload.body.get('width'), String(width), name);
    assert.equal(upload.body.get('height'), String(height), name);
    assert.equal(upload.body.get('duration'), '1', name);
    assert.equal(upload.body.get('message_thread_id'), '10');
  }
});

test('unreadable video metadata rejects before upload so the gateway can use a document', async t => {
  const path = join(await directory(t), 'broken.mp4');
  await writeFile(path, 'not a video');
  const bot = api(async () => { assert.fail('must not send a video with unknown geometry'); });
  await assert.rejects(bot.sendVideo(42, path), error => error instanceof TelegramApiError && error.code === 400);
});

test('oversize streamed downloads are removed and existing files are preserved', async t => {
  const destination = join(await directory(t), 'attachment.txt');
  const bot = api(async url => url.endsWith('/getFile') ? json({ file_path: 'documents/file.txt' }) : new Response('too long'));
  await assert.rejects(bot.download('id', destination, { maxBytes: 3 }), error => error.code === 413);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  await writeFile(destination, 'keep');
  await assert.rejects(bot.download('id', destination), error => error.code === 409);
  assert.equal(await readFile(destination, 'utf8'), 'keep');
});

test('local files are copied to a unique path without exposing source token', async t => {
  const dir = await directory(t);
  await mkdir(join(dir, TOKEN));
  const source = join(dir, TOKEN, 'original.txt');
  const destination = join(dir, 'saved.txt');
  await writeFile(source, 'original');
  const bot = api(async () => json({ file_path: source, file_id: 'file' }), { apiBase: 'http://127.0.0.1:8081', local: true });
  const result = await bot.download('file', destination);
  assert.equal(await readFile(destination, 'utf8'), 'original');
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  await assert.rejects(bot.download('file', destination), error => error.code === 409 && !error.message.includes(TOKEN));
});

test('local transfer errors and symlinks cannot leak secret paths', async t => {
  const dir = await directory(t);
  const source = join(dir, TOKEN);
  const bot = api(async () => json({ file_path: source }), { apiBase: 'http://localhost:8081', local: true });
  await assert.rejects(bot.download('file', join(dir, 'missing')), error => !error.message.includes(TOKEN));
  await writeFile(join(dir, 'real'), 'data');
  await symlink(join(dir, 'real'), source);
  await assert.rejects(bot.download('file', join(dir, 'saved')), error => error.code === 413);
});

test('cloud mode rejects absolute local paths and local mode requires loopback', async t => {
  const bot = api(async () => json({ file_path: '/etc/passwd' }));
  await assert.rejects(bot.download('file', join(await directory(t), 'x')), /untrusted absolute/);
  assert.throws(() => api(() => {}, { apiBase: 'https://example.com', local: true }), /trusted loopback/);
});

test('poll commits offsets only after durable callback and exits on stop', async () => {
  const events = [];
  const bot = api(async (url, options) => {
    assert.equal(JSON.parse(options.body).offset, 10);
    return json([{ update_id: 10 }, { update_id: 11 }]);
  });
  const offset = await bot.poll(async update => { events.push(`message:${update.update_id}`); }, {
    offset: 10,
    onOffset: async next => { events.push(`offset:${next}`); if (next === 12) bot.stop(); },
  });
  assert.equal(offset, 12);
  assert.deepEqual(events, ['message:10', 'offset:11', 'message:11', 'offset:12']);
});

test('callback failure does not commit offset or silently swallow work', async () => {
  const bot = api(async () => json([{ update_id: 1 }]));
  let committed = false;
  await assert.rejects(bot.poll(async () => { throw new Error('disk full'); }, { onOffset: () => { committed = true; } }), /disk full/);
  assert.equal(committed, false);
});

test('poll stops on duplicate-poller conflict instead of retrying forever', async () => {
  const bot = api(async () => Response.json({ ok: false, error_code: 409, description: 'Conflict' }, { status: 409 }));
  await assert.rejects(bot.poll(async () => {}), error => error.code === 409);
});

test('a slow upload does not hold other sends to the same chat', async () => {
  const order = [];
  let releaseUpload;
  const fetchImpl = async url => {
    const method = url.split('/').at(-1);
    order.push(`start:${method}`);
    if (method === 'sendDocument') await new Promise(resolve => { releaseUpload = resolve; });
    order.push(`end:${method}`);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  };
  const bot = api(fetchImpl, { minChatIntervalMs: 10 });
  const form = new FormData();
  form.set('chat_id', '7');
  form.chat_id = 7;
  const upload = bot.request('sendDocument', form);
  await new Promise(resolve => setTimeout(resolve, 30));
  await bot.request('sendMessage', { chat_id: 7, text: 'карточка' });
  assert.deepEqual(order, ['start:sendDocument', 'start:sendMessage', 'end:sendMessage']);
  releaseUpload();
  await upload;
});
