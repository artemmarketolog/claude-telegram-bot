// Checks everything the bot needs and says in plain words what to fix. Never prints secret values.
// Safe to run while the bot is running: it does not read Telegram updates.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const ok = (name, detail = '') => results.push({ level: 'ok', name, detail });
const warn = (name, detail) => results.push({ level: 'warn', name, detail });
const fail = (name, detail) => results.push({ level: 'fail', name, detail });

async function run(command, args, timeout = 30_000) {
  const { stdout, stderr } = await execute(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  return `${stdout}${stderr}`.trim();
}

// 1. Node.js
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 13)) ok('Node.js', process.versions.node);
else fail('Node.js', `нужна версия 22.13 или новее, сейчас ${process.versions.node}`);
if (existsSync(resolve(root, 'node_modules/@anthropic-ai/claude-agent-sdk'))) ok('Зависимости', 'npm install выполнен');
else fail('Зависимости', 'выполни `npm install` в папке бота');

// 2. .env
const env = process.env;
if (!existsSync(resolve(root, '.env'))) warn('.env', 'файла нет: скопируй `.env.example` в `.env` и заполни');
const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
if (/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) ok('TELEGRAM_BOT_TOKEN', 'формат верный');
else fail('TELEGRAM_BOT_TOKEN', 'не задан или неверный формат (берётся у @BotFather, вид `123456789:AA...`)');
const ownerId = Number(env.TELEGRAM_OWNER_ID);
if (Number.isSafeInteger(ownerId) && ownerId > 0) ok('TELEGRAM_OWNER_ID', 'число задано');
else fail('TELEGRAM_OWNER_ID', 'нужен твой числовой Telegram ID (например, из @userinfobot)');

// 3. ffmpeg
try { await run('ffmpeg', ['-version']); ok('ffmpeg', 'установлен'); }
catch { fail('ffmpeg', 'не найден: нужен для голосовых (Ubuntu: `sudo apt install -y ffmpeg`, macOS: `brew install ffmpeg`)'); }

// 4. Claude Code: CLI, subscription login, a real answer on the subscription
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  if (env[name]) fail(name, 'бот работает только по подписке Claude: убери эту переменную из .env и окружения');
}
const { claudeBin, chatTitle, childEnv } = await import('../lib/claude.mjs');
const bin = claudeBin();
let claudeReady = false;
if (!bin) fail('Claude Code', 'не найден: `curl -fsSL https://claude.ai/install.sh | bash` (или укажи путь в CLAUDE_BIN)');
else {
  try {
    ok('Claude Code', `${(await run(bin, ['--version'])).split('\n')[0]} (${bin})`);
    let status = {};
    try { status = JSON.parse(await run(bin, ['auth', 'status'])); } catch {}
    if (status.loggedIn && status.authMethod === 'claude.ai') { ok('Вход в Claude', `подписка${status.subscriptionType ? ` ${status.subscriptionType}` : ''}`); claudeReady = true; }
    else if (status.loggedIn) fail('Вход в Claude', 'вход выполнен не подпиской Claude. Выполни `claude auth logout`, затем `claude auth login --claudeai`');
    else fail('Вход в Claude', 'выполни `claude auth login` и войди аккаунтом с подпиской Claude Pro или Max');
  } catch { fail('Claude Code', `не запускается: ${bin}`); }
}
if (claudeReady) {
  const title = await chatTitle('Проверка связи с ботом', { env: childEnv(), executable: bin, timeoutMs: 90_000 });
  if (title) ok('Claude отвечает', 'по подписке (короткий запрос к Haiku)');
  else fail('Claude отвечает', 'пробный запрос не прошёл: проверь `claude auth status` и лимиты подписки, затем запусти `claude` в терминале и отправь любое сообщение');
}

// 5. Telegram: identity, Threaded Mode, owner chat
if (token && Number.isSafeInteger(ownerId) && ownerId > 0) {
  const { BotApi, apiOptionsFromEnv } = await import('../lib/telegram.mjs');
  const options = apiOptionsFromEnv();
  try {
    const api = new BotApi({ token, ...options, minChatIntervalMs: 0 });
    const me = await api.request('getMe');
    ok('Бот в Telegram', `@${me.username}${options.local ? ' (свой Local Bot API)' : ''}`);
    if (options.local) ok('Большие файлы', `свой Local Bot API ${options.apiBase}: файлы до 2000 МБ в обе стороны`);
    else warn('Большие файлы', 'облачный Bot API: бот получает файлы до 20 МБ и отправляет до 50 МБ. Для больших — `bash scripts/install-local-bot-api.sh` (docs/LOCAL-BOT-API.md)');
    if (me.has_topics_enabled) ok('Threaded Mode', 'темы в личном чате включены');
    else fail('Threaded Mode', 'выключен. @BotFather → кнопка Open (мини-приложение) → My bots → бот → Bot Settings → Threads Settings → включи Threaded Mode. Командами в чате BotFather это не делается');
    if (me.has_topics_enabled && me.allows_users_to_create_topics === false) warn('Создание тем', 'пользователю запрещено создавать темы: включи это там же, в Threads Settings');
    try {
      await api.request('sendChatAction', { chat_id: ownerId, action: 'typing' });
      ok('Чат владельца', 'бот может писать владельцу');
    } catch (error) {
      fail('Чат владельца', /chat not found|bot was blocked|user not found/i.test(error.message)
        ? 'бот не может написать тебе: открой бота в Telegram и нажми Start, проверь TELEGRAM_OWNER_ID'
        : `Telegram ответил ошибкой: ${error.message}`);
    }
  } catch (error) {
    fail('Бот в Telegram', error.code === 401 ? (options.local ? 'свой Local Bot API не принял токен: проверь TELEGRAM_BOT_TOKEN и сервис telegram-bot-api' : 'Telegram отклонил токен: возьми актуальный у @BotFather') : `нет связи с ${options.local ? `Local Bot API ${options.apiBase} (запущен ли сервис telegram-bot-api?)` : 'Telegram'}: ${error.message}`);
  }
}

// 6. Voice: OpenAI (recommended) or local whisper.cpp (free)
if (env.OPENAI_API_KEY) {
  try {
    const response = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, signal: AbortSignal.timeout(20_000) });
    await response.body?.cancel();
    if (response.ok) ok('Голосовые: OpenAI', 'ключ принят (баланс проверь на platform.openai.com → Billing)');
    else fail('Голосовые: OpenAI', response.status === 401 ? 'ключ OpenAI неверный или отозван' : `OpenAI ответил ${response.status}`);
  } catch { warn('Голосовые: OpenAI', 'не удалось связаться с api.openai.com'); }
} else if (env.LOCAL_STT_MODEL) {
  const cli = env.LOCAL_STT_CLI || (/parakeet/i.test(env.LOCAL_STT_MODEL) ? 'parakeet-cli' : 'whisper-cli');
  try { await access(env.LOCAL_STT_MODEL, constants.R_OK); ok('Локальная модель речи', env.LOCAL_STT_MODEL); }
  catch { fail('Локальная модель речи', `файл не найден: ${env.LOCAL_STT_MODEL}`); }
  try { await run(cli, ['--help'], 15_000); ok('Голосовые: локально', cli); }
  catch { fail('Голосовые: локально', `${cli} не найден: \`bash scripts/install-local-stt.sh\` или путь в LOCAL_STT_CLI`); }
} else warn('Голосовые', 'не настроены: добавь OPENAI_API_KEY (рекомендуется) или локальную модель (docs/VOICE.md). Текст и файлы работают и без этого');

// 7. Projects
try {
  const { readProjects } = await import('../lib/projects.mjs');
  const projects = readProjects(resolve(root, env.PROJECTS_FILE || 'projects.json'));
  ok('Проекты', projects.map(p => `${p.label} (${p.path})`).join(', '));
} catch (error) { fail('Проекты', error.message); }

const icon = { ok: '✅', warn: '⚠️', fail: '❌' };
for (const item of results) console.log(`${icon[item.level]} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
const failed = results.filter(item => item.level === 'fail').length;
console.log(failed ? `\nНужно исправить: ${failed}.` : '\nВсё готово. Запусти бота: `npm start` (или установи автозапуск: `bash scripts/install-service.sh`).');
process.exitCode = failed ? 1 : 0;
