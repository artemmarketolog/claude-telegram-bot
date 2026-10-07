import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, open, readdir, readFile, stat, statfs, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { isOwner } from './state.mjs';
import { prepareMedia, safeFilename } from './media.mjs';
import { userPrompt, assistantText, taskNotification } from './desktop.mjs';
import { projectFor } from './projects.mjs';
import { CLOUD_UPLOAD_LIMIT, escapeHtml, renderTelegramHtml, TelegramApiError } from './telegram.mjs';
import { actionLabel, age, backgroundLine, cardText, finalLine, shortModel, titleFrom, tokens, topicIcon, topicName } from './format.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MEDIA = ['document', 'photo', 'voice', 'audio', 'video', 'video_note', 'animation', 'sticker'];
const COMMANDS = ['start', 'help', 'new', 'sessions', 'model', 'stop', 'queue', 'files', 'context', 'compact', 'archive'];
const IDLE_CLOSE_MS = 30 * 60 * 1000;
const OUTPUT_KEEP_MS = 14 * 86400000;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FALLBACK_MODELS = [
  { value: 'opus[1m]', displayName: 'Opus' }, { value: 'fable', displayName: 'Fable' },
  { value: 'sonnet', displayName: 'Sonnet' }, { value: 'haiku', displayName: 'Haiku' },
];
// The menu shows the newest model of each family, in this order, named with its version (Opus 5.5 …).
const FAMILIES = ['opus', 'fable', 'sonnet', 'haiku'];
// After max: ultracode (xhigh plus standing workflow orchestration), offered where xhigh is.
const effortsOf = model => { const list = Array.isArray(model?.efforts) ? model.efforts : EFFORTS; return list.includes('xhigh') ? [...list, 'ultracode'] : list; };
// What the agent says along the way: its text, else the thinking summary the desktop app shows too.
const saying = (content = []) => {
  const pick = type => content.filter(c => c?.type === type).map(c => (type === 'text' ? c.text : c.thinking) ?? '').join('\n').trim();
  return pick('text') || pick('thinking');
};
// One commentary entry for the card: at most 700 characters, without code fences and quote marks
// (a quote or code block cannot sit inside the card's expandable quote).
const noteText = note => {
  const chars = Array.from(String(note).replace(/^[ \t]*(`{3,}|~{3,}).*$/gm, '').replace(/^[ \t]*>[ \t]?/gm, '').replace(/\n{3,}/g, '\n\n').trim());
  return chars.length > 700 ? `${chars.slice(0, 699).join('')}…` : chars.join('');
};
// The turn's commentary log: consecutive repeats are skipped, the oldest go beyond 200 entries.
const addNote = (notes = [], note) => notes.at(-1) === note ? notes : [...notes, note].slice(-200);
const cutText = (value, max) => { const t = String(value ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
// Workflow tool input carries its name only inside the script's `meta` literal.
const workflowName = input => String(input?.script ?? '').match(/\bname:\s*['"`]([^'"`]+)['"`]/)?.[1] || input?.name || 'workflow';
const backgroundName = tool => tool.name === 'Workflow' ? `workflow «${cutText(workflowName(tool.input), 24)}»`
  : tool.name === 'Bash' ? `bash: ${cutText(tool.input?.description || tool.input?.command, 20)}`
    : `агент «${cutText(tool.input?.description || tool.input?.subagent_type, 20)}»`;
// Registry status: anything but idle/unknown means the process is working (busy, waiting, shell, …).
const busy = status => status != null && status !== 'idle';
const topicGone = error => error instanceof TelegramApiError && error.code === 400 && /thread not found|topic_deleted|topic.*(deleted|closed)|TOPIC_ID_INVALID/i.test(error.message);
// Operations under one key run strictly one after another (turn locks, mirror passes).
async function serialize(locks, key, operation) {
  const work = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  locks.set(key, work);
  try { return await work; } finally { if (locks.get(key) === work) locks.delete(key); }
}

export const TOPICS_HELP = 'Включи темы для бота: @BotFather → кнопка Open (мини-приложение) → My bots → этот бот → Bot Settings → Threads Settings → Threaded Mode, и оставь включённым создание тем пользователями. В чате с BotFather командами это не включается.';

export class Gateway {
  constructor({ api, state, desktop, ownerId, botId = null, dataDir, projects, defaultPath = null, home = homedir(), defaults, runnerFactory, titler = null, secrets = [] }) {
    Object.assign(this, { api, state, desktop, ownerId, botId, dataDir, projects, defaultPath, home, defaults, runnerFactory, titler, secrets });
    this.runners = new Map();
    this.questions = new Map();
    this.workers = new Map();
    this.turnLocks = new Map();
    this.mirrors = new Map();
    this.cardLocks = new Map();
    this.media = new Map();
    this.botTopics = new Set();
    this.chains = new Map();
    this.tasks = new Set();
    this.stopping = false;
  }

  // ---------- plumbing ----------
  clean(text) {
    let value = String(text ?? '');
    for (const secret of this.secrets) if (secret) value = value.split(secret).join('[секрет скрыт]');
    return value.replace(/\b\d{6,13}:[A-Za-z0-9_-]{30,}\b/g, '[Telegram token скрыт]')
      .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, '[ключ скрыт]').replace(/\bEAA[A-Za-z0-9]{60,}\b/g, '[Meta token скрыт]')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[GitHub token скрыт]').replace(/\bya29\.[A-Za-z0-9_-]{40,}/g, '[Google token скрыт]')
      .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[Google key скрыт]').replace(/\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g, '[Slack token скрыт]');
  }
  log(kind, error) { console.error(JSON.stringify({ at: new Date().toISOString(), kind, message: this.clean(error?.message ?? error).slice(0, 500) })); }
  button(text, type, data = {}, style) {
    const key = createHash('sha256').update(JSON.stringify({ type, data })).digest('base64url').slice(0, 18);
    this.state.set(`action:${key}`, { type, data, at: Date.now() });
    return { text, callback_data: `a:${key}`, ...(style ? { style } : {}) };
  }
  project(key) { return this.projects.find(p => p.key === key) ?? null; }
  // Claude events are serialized per chat: one chat's slow upload never delays another chat.
  enqueueEvent(chatId, fn) {
    const next = (this.chains.get(chatId) ?? Promise.resolve()).then(fn).catch(error => this.log('event_error', error));
    this.chains.set(chatId, next);
    void next.then(() => { if (this.chains.get(chatId) === next) this.chains.delete(chatId); });
    return next;
  }
  get eventChain() { return Promise.allSettled([...this.chains.values()]); }
  get idle() { return Promise.allSettled([...this.tasks]); }
  // Buttons and commands run beside the poller (their update row is already durable): a file upload
  // or a process that takes seconds to close in one chat must not hold messages to every other chat.
  detach(update, operation, topicId, kind) {
    this.state.updateStatus(update.update_id, 'processing');
    const task = (async () => {
      try { await operation(); this.state.updateStatus(update.update_id, 'done'); }
      catch (error) {
        this.state.updateStatus(update.update_id, 'error');
        this.log(kind, error);
        await this.send(`✗ ${this.clean(error.message).slice(0, 200)}`, { topicId }).catch(() => {});
      }
    })().catch(error => this.log(kind, error)).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }
  chat(id) { return this.state.chat(id); }
  save(value) { return this.state.saveChat(value); }

  async send(text, { topicId, chatId, ...options } = {}) {
    const messages = await this.api.sendText(this.ownerId, this.clean(text), { ...options, ...(topicId ? { message_thread_id: topicId } : {}) });
    for (const message of messages) if (chatId && message?.message_id) this.state.bind(message.message_id, chatId);
    return messages;
  }
  async edit(messageId, text, options = {}) { return this.api.editText(this.ownerId, messageId, this.clean(text), options); }
  async react(messageId, emoji) {
    if (!messageId || messageId < 0) return;
    await this.api.request('setMessageReaction', { chat_id: this.ownerId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] }).catch(error => this.log('reaction_error', error));
  }

  // Send into a chat's topic; recreate the topic once if the user deleted it.
  // recreate:false — background noise (the desktop mirror) must not resurrect a topic the user deleted.
  async sendToChat(chatId, fn, { recreate = true } = {}) {
    if (!recreate && !this.chat(chatId)?.topicId) return [];
    let topicId = await this.ensureTopic(chatId);
    try { return await fn(topicId); }
    catch (error) {
      if (!topicGone(error)) throw error;
      this.state.unbindTopic(topicId);
      this.save({ id: chatId, topicId: null, statusMessageId: null });
      if (!recreate) return [];
      topicId = await this.ensureTopic(chatId);
      return fn(topicId);
    }
  }
  async say(chatId, text, { recreate, ...options } = {}) { return this.sendToChat(chatId, topicId => this.send(text, { ...options, topicId, chatId }), { recreate }); }
  async sendHtml(chatId, html, { recreate } = {}) {
    return this.sendToChat(chatId, async topicId => {
      const message = await this.api.request('sendMessage', { chat_id: this.ownerId, message_thread_id: topicId, text: html, parse_mode: 'HTML' });
      if (message?.message_id) this.state.bind(message.message_id, chatId);
      return message;
    }, { recreate });
  }

  async ensureTopic(chatId) {
    const chat = this.chat(chatId);
    if (chat.topicId && this.state.chatForTopic(chat.topicId) === chatId) return chat.topicId;
    const icon = this.iconFor(chat);
    const topic = await this.api.request('createForumTopic', { chat_id: this.ownerId, name: topicName(chat.project, chat.title), ...(icon ? { icon_custom_emoji_id: icon } : { icon_color: 16766590 }) });
    this.botTopics.add(topic.message_thread_id);
    this.state.bindTopic(topic.message_thread_id, chatId);
    this.save({ id: chatId, topicId: topic.message_thread_id, topicNamedBy: 'bot', statusMessageId: null });
    return topic.message_thread_id;
  }
  iconFor(chat) {
    const icons = this.state.get('topicIcons') ?? {};
    return icons[topicIcon(`${chat.project} ${chat.cwd}`)] ?? null;
  }
  async loadIcons() {
    try {
      const list = await this.api.request('getForumTopicIconStickers');
      this.state.set('topicIcons', Object.fromEntries(list.map(s => [s.emoji, s.custom_emoji_id])));
    } catch (error) { this.log('icons_error', error); }
  }
  async renameTopic(chatId, title) {
    const chat = this.chat(chatId);
    if (!chat.topicId || chat.topicNamedBy === 'user') return;
    const name = topicName(chat.project, title);
    if (name === chat.topicName) return;
    await this.api.request('editForumTopic', { chat_id: this.ownerId, message_thread_id: chat.topicId, name })
      .then(() => this.save({ id: chatId, topicName: name })).catch(error => this.log('topic_rename_error', error));
  }

  // ---------- lifecycle ----------
  async start() {
    const me = await this.api.request('getMe');
    if (this.botId && me.id !== this.botId) throw new Error('Configured token belongs to another bot.');
    await this.api.request('setMyCommands', { commands: [
      { command: 'new', description: 'Новый чат' }, { command: 'sessions', description: 'Сессии: бот и компьютер' },
      { command: 'model', description: 'Модель и effort' }, { command: 'stop', description: 'Остановить' },
      { command: 'queue', description: 'Следующий запрос: /queue текст' }, { command: 'context', description: 'Контекст сессии' },
      { command: 'files', description: 'Файлы чата' }, { command: 'compact', description: 'Сжать контекст' },
      { command: 'archive', description: 'Архивировать чат' },
    ] });
    this.state.pruneActions(7 * 86400000);
    const interrupted = this.state.recoverUpdates();
    const uncertain = this.state.recoverQueue();
    for (const item of uncertain) {
      this.save({ id: item.threadId, queuePaused: true });
      await this.say(item.threadId, `⚠ запрос из очереди «${cutText(item.preview, 60)}» мог не уйти из-за перезапуска · проверь ответ, затем /queue → ✕ или ▶`, { recreate: false }).catch(() => {});
    }
    for (const chat of this.state.chats().filter(c => c.status === 'active')) await this.recoverTurn(chat).catch(error => this.log('recover_error', error));
    if (interrupted) await this.send(`⚠ ${interrupted} сообщ. не подтверждены после перезапуска бота. Проверь последние ответы перед повтором.`).catch(() => {});
    // Every chat lives in a topic of the private chat: without Threaded Mode nothing can work.
    if (!me.has_topics_enabled) {
      this.log('topics_disabled', 'Threaded Mode is off in BotFather');
      await this.send(TOPICS_HELP).catch(error => this.log('topics_disabled', error));
    } else if (!this.state.get('welcomed')) {
      await this.send('Claude на связи. Одна тема — один чат Claude. Напиши задачу сюда — я открою для неё тему. /start — меню.').catch(() => {});
      this.state.set('welcomed', Date.now());
    }
    this.timers = [
      setInterval(() => { void this.refreshCards(); }, 8000),
      setInterval(() => { void this.pollMirrors(); }, 5000),
      setInterval(() => { void this.closeIdle(); }, 60000),
      setInterval(() => { void this.retryHeld(); }, 60000),
      setInterval(() => { void this.pollNewSessions(); }, 60000),
      setInterval(() => { try { this.state.prune(); } catch (error) { this.log('prune_error', error); } void this.pruneOutputs(); }, 6 * 3600000),
    ];
    this.state.prune();
    void this.pruneOutputs();
    void this.loadModels();
    this.drain();
    void this.retryHeld();
    void this.loadIcons();
  }

  // The bot restarted mid-turn: its runner died with it. Deliver an answer the transcript already has.
  async recoverTurn(chat) {
    const answer = await this.transcriptAnswerSince(chat.id, chat.turnStartedAt ?? 0);
    if (answer) {
      await this.deliverAnswer(chat.id, answer.text, `answer:${chat.id}:${answer.uuid}`);
      this.save({ id: chat.id, status: 'idle', outcome: 'ok', turnMs: Date.now() - (chat.turnStartedAt ?? Date.now()) });
    } else this.save({ id: chat.id, status: 'idle', outcome: 'error', error: 'ход прерван перезапуском бота — напиши, чтобы продолжить' });
    await this.refreshCard(chat.id);
  }
  async transcriptAnswerSince(chatId, since) {
    const path = await this.desktop.pathFor(chatId);
    if (!path) return null;
    const { records } = await this.desktop.read(path, Math.max(0, (await this.desktop.size(path)) - 8 * 1024 * 1024));
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (Date.parse(r.timestamp) < since) break;
      const text = assistantText(r);
      if (text && r.message?.stop_reason === 'end_turn') return { text, uuid: r.uuid };
    }
    return null;
  }

  async loadModels() {
    const cached = this.state.get('models');
    if (cached?.at > Date.now() - 86400000) return cached.list;
    const runner = this.runnerFactory({ id: randomUUID(), cwd: this.defaultProject().path, probe: true });
    try {
      const list = await Promise.race([runner.models(), delay(30000).then(() => [])]);
      if (list.length) this.state.set('models', { at: Date.now(), list: list.map(m => ({ value: m.value, resolved: m.resolvedModel, displayName: m.displayName, efforts: m.supportedEffortLevels ?? [] })) });
    } catch (error) { this.log('models_error', error); }
    finally { await runner.close(5000).catch(() => {}); }
    return this.state.get('models')?.list ?? FALLBACK_MODELS;
  }
  models() { return this.state.get('models')?.list ?? FALLBACK_MODELS; }

  // Runners close first while Telegram still works; turns cut by the shutdown stay `active`
  // so recoverTurn on the next start delivers the answer already in the transcript.
  async close() {
    this.stopping = true;
    for (const timer of this.timers ?? []) clearInterval(timer);
    for (const job of this.media.values()) job.controller.abort();
    await Promise.allSettled([...this.runners.values()].map(r => r.close(10000)));
    await this.eventChain;
    await Promise.allSettled([...this.workers.values()]);
    this.api.stop();
    // Buttons and commands still running (e.g. a file upload) end on the aborted Telegram requests.
    await this.idle;
  }

  // ---------- intake ----------
  command(text = '') {
    const match = String(text).match(/^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    return match && COMMANDS.includes(match[1]) ? { name: match[1], args: (match[2] ?? '').trim() } : null;
  }

  async receive(update) {
    if (!isOwner(update, this.ownerId)) return;
    if (update.callback_query) {
      if (this.state.enqueue(update, null)) this.detach(update, () => this.callback(update.callback_query), update.callback_query.message?.message_thread_id, 'callback_error');
      return;
    }
    const msg = update.message;
    if (!msg) return;
    const topicId = msg.is_topic_message ? msg.message_thread_id : null;
    if (msg.forum_topic_created) return this.onTopicCreated(msg).catch(error => this.log('topic_start_error', error));
    if (msg.forum_topic_edited) {
      const chatId = this.state.chatForTopic(topicId);
      if (chatId && msg.from?.id === this.ownerId && msg.forum_topic_edited.name) this.save({ id: chatId, topicNamedBy: 'user', topicName: msg.forum_topic_edited.name });
      return;
    }
    const hasContent = Boolean(msg.text || msg.caption || MEDIA.some(k => msg[k]));
    if (!hasContent) return;
    const command = this.command(msg.text);
    const chatId = this.state.chatForTopic(topicId);
    if (command && !(command.name === 'queue' && command.args)) {
      if (this.state.enqueue(update, chatId)) this.detach(update, () => this.control(command, { topicId, chatId, message: msg }), topicId, 'control_error');
      return;
    }
    if (command?.name === 'queue') update = { ...update, deliveryMode: 'queued', message: { ...msg, text: command.args } };
    if (!topicId) return this.holdInLobby(update);
    if (!chatId) return this.holdInTopic(update, topicId);
    // A plain correction (or an answer to Claude's question) must not wait behind this chat's download.
    const openQuestion = [...this.questions.values()].find(q => q.chatId === chatId);
    if (openQuestion && msg.text && !update.deliveryMode && this.media.has(chatId)) {
      if (this.state.enqueue(update, chatId)) { this.state.updateStatus(update.update_id, 'done'); await this.answerFree(openQuestion, msg.text, msg.message_id); }
      return;
    }
    if (this.media.has(chatId) && msg.text && !update.deliveryMode && this.runners.get(chatId)?.active) {
      if (!this.state.enqueue(update, chatId)) return;
      this.state.updateStatus(update.update_id, 'processing');
      try { await this.dispatch(chatId, [{ type: 'text', text: msg.text }], msg.message_id); this.state.updateStatus(update.update_id, 'done'); }
      catch (error) { this.state.updateStatus(update.update_id, 'error'); this.log('steer_error', error); }
      return;
    }
    if (!this.state.enqueue(update, chatId)) return;
    this.drain();
  }

  // A message outside a known chat starts work at once in the default project; one line with
  // «сменить проект» lets the owner move it.
  defaultProject() { return this.projects.find(p => p.path === this.defaultPath) ?? this.projects[0] ?? projectFor(this.projects, this.home); }
  // Sessions in the user's folders count; dot-folders (~/.claude and the like) do not.
  inHome(cwd) { return String(cwd).startsWith(`${this.home}/`) && !String(cwd).startsWith(`${this.home}/.`) || cwd === this.home; }

  async startDefaultChat({ topicId = null, held = null, implicit = true } = {}) {
    const chat = await this.createChat(this.defaultProject(), { topicId, implicit });
    const [line] = await this.say(chat.id, `📁 ${chat.project}`, { reply_markup: { inline_keyboard: [[this.button('сменить проект', 'move', { chatId: chat.id })]] } }).catch(() => []);
    if (line) this.save({ id: chat.id, projectLineId: line.message_id });
    // Released only now: the line comes before the card, and the rest of an album joins in time.
    if (held) { this.state.release(held, chat.id); this.drain(); }
    return this.chat(chat.id);
  }

  // Messages held for a chat whose topic Telegram did not create: started again every minute.
  async retryHeld() {
    for (const key of this.state.heldKeys()) {
      if (this.stopping) return;
      const topicId = key.startsWith('topic:') ? Number(key.slice(6)) : null;
      const chatId = topicId ? this.state.chatForTopic(topicId) : null;
      if (chatId) { this.state.release(key, chatId); this.drain(); continue; }
      await this.startDefaultChat({ topicId, held: key }).catch(error => this.log('held_retry_error', error));
    }
  }

  async holdInLobby(update) {
    // An album or a quick burst of lobby messages belongs to one chat (one topic).
    const recent = this.lastLobby;
    const group = update.message?.media_group_id;
    if (recent && this.chat(recent.chatId) && (group ? recent.group === group : Date.now() - recent.at < 30000)) {
      recent.at = Date.now();
      if (this.state.enqueue(update, recent.chatId)) this.drain();
      return;
    }
    const key = `lobby:${update.update_id}`;
    if (!this.state.hold(update, key) && !this.state.held(key).length) return;
    // A failed topic never stops polling (and every other chat): the message stays held for retryHeld.
    const chat = await this.startDefaultChat({ held: key }).catch(error => { this.log('lobby_topic_error', error); return null; });
    if (chat) this.lastLobby = { chatId: chat.id, at: Date.now(), group: group ?? null };
  }

  async holdInTopic(update, topicId) {
    const key = `topic:${topicId}`;
    if (!this.state.hold(update, key) && !this.state.held(key).length) return;
    if (this.state.chatForTopic(topicId)) { this.state.release(key, this.state.chatForTopic(topicId)); this.drain(); return; }
    await this.startDefaultChat({ topicId, held: key }).catch(error => this.log('topic_start_error', error));
  }

  async onTopicCreated(msg) {
    const topicId = msg.message_thread_id;
    if (this.botTopics.has(topicId) || msg.from?.is_bot || this.state.chatForTopic(topicId)) return;
    const implicit = Boolean(msg.forum_topic_created.is_name_implicit);
    const chat = await this.startDefaultChat({ topicId, implicit });
    // Telegram names the topic after its first message; «/new» from the «Новый чат» button says nothing.
    if (implicit && String(msg.forum_topic_created.name).startsWith('/')) await this.renameTopic(chat.id, chat.title);
  }

  // Per-chat sequential workers: one chat's long download never blocks another chat.
  drain() {
    if (this.stopping) return;
    const threads = new Set(this.state.pending().map(row => row.thread_id));
    for (const threadId of threads) {
      if (this.workers.has(threadId)) continue;
      const work = (async () => {
        try {
          for (;;) {
            const row = this.state.pending().find(r => r.thread_id === threadId);
            if (!row || this.stopping) break;
            // Album: photos of one media group arrive as separate updates; send them as one request.
            let rows = [row];
            const group = row.payload.message?.media_group_id;
            if (group) {
              await delay(1500);
              rows = this.state.pending().filter(r => r.thread_id === threadId && r.payload.message?.media_group_id === group);
            }
            for (const r of rows) this.state.updateStatus(r.id, 'processing');
            try {
              await this.content(rows.map(r => r.payload.message), threadId, { queued: row.payload.deliveryMode === 'queued' });
              for (const r of rows) this.state.updateStatus(r.id, 'done');
            } catch (error) {
              if (error.retry) { for (const r of rows) this.state.updateStatus(r.id, 'pending'); break; }
              for (const r of rows) this.state.updateStatus(r.id, 'error');
              this.log('message_error', error);
              await this.say(threadId, `✗ ${this.clean(error.message).slice(0, 300)}`).catch(() => {});
            }
          }
        } finally { this.workers.delete(threadId); }
      })();
      this.workers.set(threadId, work);
    }
  }

  // ---------- chats ----------
  // Model and effort of every chat the bot starts or opens: /model in General, else ~/.claude/settings.json.
  chatDefaults() { return { model: this.state.get('defaultModel') ?? this.defaults.model, effort: this.state.get('defaultEffort') ?? this.defaults.effort }; }

  newChatRecord(project, { title = 'Новый чат' } = {}) {
    return this.save({ id: randomUUID(), cwd: project.path, project: project.label, title, origin: 'bot', created: Date.now(),
      ...this.chatDefaults(), status: 'idle', started: false, untitled: true });
  }

  async createChat(project, { topicId = null, implicit = true } = {}) {
    const chat = this.newChatRecord(project);
    if (topicId) {
      this.state.bindTopic(topicId, chat.id);
      this.save({ id: chat.id, topicId, topicNamedBy: implicit ? 'bot' : 'user' });
      const icon = this.iconFor(this.chat(chat.id));
      if (icon) await this.api.request('editForumTopic', { chat_id: this.ownerId, message_thread_id: topicId, icon_custom_emoji_id: icon }).catch(error => this.log('icon_set_error', error));
    } else await this.ensureTopic(chat.id);
    return this.chat(chat.id);
  }

  // A chat started (or resumed) in the desktop app gets its topic by itself within a minute. Only activity
  // after the feature was switched on counts; a topic the owner deleted or archived is not brought back.
  async pollNewSessions() {
    if (this.stopping || this.newSessionsBusy) return;
    this.newSessionsBusy = true;
    try {
      let since = this.state.get('autoTopicsSince');
      if (!since) this.state.set('autoTopicsSince', since = Date.now());
      const eligible = s => !this.chat(s.sessionId);
      const fresh = (await this.desktop.list({ limit: 60 })).filter(s => s.entrypoint === 'claude-desktop' && s.lastActivity > since
        && this.inHome(s.cwd) && eligible(s));
      for (const session of fresh.slice(0, 5).reverse()) {
        if (this.stopping) return;
        await this.openSession(session.sessionId, { fromStart: !this.chat(session.sessionId) && session.created > since }).catch(error => this.log('auto_topic_error', error));
      }
    } finally { this.newSessionsBusy = false; }
  }

  // fromStart (a chat not known yet): mirrored from its first message instead of showing the last answer.
  async openSession(sessionId, { fromStart = false } = {}) {
    let chat = this.chat(sessionId);
    if (!chat) {
      const path = await this.desktop.pathFor(sessionId);
      if (!path) throw new Error('Сессия не найдена.');
      const info = await this.desktop.info(path);
      const project = projectFor(this.projects, info.cwd);
      chat = this.save({ id: sessionId, cwd: info.cwd, project: project.label, title: info.title || 'Сессия', origin: info.entrypoint === 'sdk-ts' ? 'bot' : 'desktop',
        ...this.chatDefaults(), status: 'idle', started: true, untitled: false, mirrorOffset: fromStart ? 0 : info.size });
    }
    if (chat.archived) chat = this.save({ id: sessionId, archived: false });
    if (chat.topicId && this.state.chatForTopic(chat.topicId) === sessionId) {
      // A topic the user deleted leaves no update; probe it silently before trusting the binding.
      // sendChatAction succeeds even for deleted topics; editForumTopic with the same icon does not.
      await this.api.request('editForumTopic', { chat_id: this.ownerId, message_thread_id: chat.topicId, icon_custom_emoji_id: this.iconFor(chat) ?? '' }).catch(error => {
        if (topicGone(error)) { this.state.unbindTopic(chat.topicId); chat = this.save({ id: sessionId, topicId: null, statusMessageId: null }); }
      });
    }
    const fresh = !chat.topicId || this.state.chatForTopic(chat.topicId) !== sessionId;
    const topicId = await this.ensureTopic(sessionId);
    if (fresh && !fromStart) {
      // The new topic mirrors what happens from now on, not everything since the old topic was deleted.
      const path = await this.desktop.pathFor(sessionId);
      if (path) await serialize(this.mirrors, sessionId, async () => { this.save({ id: sessionId, mirrorOffset: await this.desktop.size(path) }); });
      const answer = await this.desktop.lastAnswer(sessionId);
      if (answer) await this.deliverAnswer(sessionId, answer, `open:${sessionId}:${createHash('sha256').update(answer).digest('hex').slice(0, 12)}`, { artifacts: false });
      const foreign = await this.desktop.foreign(sessionId);
      if (foreign && busy(foreign.status)) await this.beginTurn(sessionId, { status: 'desktop' });
    }
    return this.chat(sessionId);
  }

  // ---------- content ----------
  async content(input, chatId, { queued = false } = {}) {
    const messages = (Array.isArray(input) ? input : [input]).filter(Boolean);
    if (!messages.length) return;
    let chat = this.chat(chatId);
    if (!chat || chat.archived) return;
    const message = messages[0];
    const text = messages.map(m => m.text ?? m.caption ?? '').filter(Boolean).join('\n');
    const hasMedia = messages.some(m => MEDIA.some(k => m[k]));
    const question = [...this.questions.values()].find(q => q.chatId === chatId);
    if (!queued && question && text && !hasMedia) return this.answerFree(question, text, message.message_id);
    const blocks = [];
    const attachments = [];
    let transcript = null;
    if (hasMedia) {
      for (const item of messages) {
        const received = await this.receiveMedia(item, chatId);
        if (!received) return;
        attachments.push(...received.attachments);
        transcript = transcript ?? received.transcript ?? null;
        for (const part of received.inputs) {
          if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
          if (part.type === 'localImage') { const image = await imageBlock(part.path); if (image) blocks.push(image); }
        }
      }
    } else if (text) blocks.push({ type: 'text', text });
    if (!blocks.length || this.chat(chatId)?.archived) return;
    for (const item of messages) this.state.bind(item.message_id, chatId);
    for (const file of attachments) this.state.addFile(chatId, { ...file, direction: 'in' });
    if (chat.untitled) {
      const title = titleFrom(text || transcript || attachments[0]?.name);
      chat = this.save({ id: chatId, title, untitled: false, firstMessages: messages });
      await this.renameTopic(chatId, title);
    }
    if (queued) {
      const item = this.state.queueTurn(chatId, { messageId: message.message_id, input: blocks, preview: this.clean(text || transcript || attachments[0]?.name || 'вложение').replace(/\s+/g, ' ').slice(0, 120) });
      if (item) await this.react(message.message_id, '✍');
      if (this.chat(chatId).queuePaused) await this.say(chatId, 'очередь на паузе · /queue → ▶ Продолжить');
      return this.runQueued(chatId);
    }
    await this.dispatch(chatId, blocks, message.message_id);
  }

  async receiveMedia(message, chatId) {
    const chat = this.chat(chatId);
    const audio = Boolean(message.voice || message.audio || message.video_note);
    const [progress] = await this.say(chatId, audio ? '🎙 …' : '📎 …', {}).catch(() => []);
    const job = { controller: new AbortController() };
    this.media.set(chatId, job);
    let received;
    try {
      received = await prepareMedia(message, { api: this.api, threadId: chatId, filesRoot: join(this.dataDir, 'files'), openaiKey: process.env.OPENAI_API_KEY,
        signal: job.controller.signal, onStatus: async status => { if (progress) await this.edit(progress.message_id, `${audio ? '🎙' : '📎'} ${status}`).catch(() => {}); } });
      job.controller.signal.throwIfAborted();
    } catch (error) {
      if (job.controller.signal.aborted && this.stopping) {
        // Bot shutdown, not the user's /stop: the message goes back to the queue for the next start.
        if (progress) await this.api.request('deleteMessage', { chat_id: this.ownerId, message_id: progress.message_id }).catch(() => {});
        throw Object.assign(new Error('bot is stopping'), { retry: true });
      }
      if (progress) await this.edit(progress.message_id, job.controller.signal.aborted ? '■ остановлено' : `✗ ${this.clean(error.message).slice(0, 200)}`).catch(() => {});
      if (job.controller.signal.aborted) return null;
      throw error;
    } finally { if (this.media.get(chatId) === job) this.media.delete(chatId); }
    if (progress) {
      if (received.transcript) {
        const shown = Array.from(received.transcript).slice(0, 3800).join('');
        await this.api.request('editMessageText', { chat_id: this.ownerId, message_id: progress.message_id, parse_mode: 'HTML',
          text: `🎙 <blockquote expandable>${escapeHtml(this.clean(shown))}</blockquote>` }).catch(error => this.log('transcript_edit_error', error));
      } else if (received.warnings?.length) await this.edit(progress.message_id, `⚠ ${received.warnings.join(' ')}`).catch(() => {});
      else await this.api.request('deleteMessage', { chat_id: this.ownerId, message_id: progress.message_id }).catch(() => {});
    }
    void chat;
    return received;
  }

  withTurnLock(id, operation) { return serialize(this.turnLocks, id, operation); }

  // The CLI has reported the turn's result, but finishTurn has not closed it yet.
  resultPending(chatId) {
    const runner = this.runners.get(chatId);
    return Boolean(runner?.alive && !runner.active && this.chat(chatId)?.status === 'active');
  }

  async dispatch(chatId, blocks, messageId) {
    for (let attempt = 0; ; attempt++) {
      // A message sent as the answer arrives starts its own turn and card, after the finished one closes.
      if (this.resultPending(chatId)) await this.chains.get(chatId);
      const done = await this.withTurnLock(chatId, async () => {
        if (this.chat(chatId)?.archived) return true;
        if (this.resultPending(chatId) && attempt < 3) return false;
        const runner = await this.ensureRunner(chatId);
        if (!runner) {
          // The session is working in the desktop app; send right after it finishes.
          this.state.queueTurn(chatId, { messageId, input: blocks, preview: 'после компьютера' });
          this.save({ id: chatId, waitDesktop: true, queuePaused: false });
          await this.react(messageId, '✍');
          return true;
        }
        if (runner.active) { runner.push(blocks, { priority: 'next' }); await this.react(messageId, '👀'); return true; }
        await this.beginTurn(chatId);
        runner.push(blocks);
        await this.react(messageId, '👀');
        return true;
      });
      if (done) return;
    }
  }

  // Closes an idle runner under the turn lock, so a message being dispatched never lands in a closing process.
  async retire(chatId, runner) {
    await this.withTurnLock(chatId, async () => {
      if (this.runners.get(chatId) !== runner || runner.active) return;
      this.runners.delete(chatId);
      await runner.close();
    });
  }

  // One live process per session. A foreign idle process (desktop app, terminal) is stopped first,
  // so two processes never append to one transcript; a busy one is left alone.
  async ensureRunner(chatId) {
    const chat = this.chat(chatId);
    let runner = this.runners.get(chatId);
    const foreign = chat.started ? await this.desktop.foreign(chatId) : null;
    if (runner?.alive && !runner.closed && (runner.active || !foreign)) return runner;
    if (runner?.alive) { this.runners.delete(chatId); await runner.close(); }
    let model = chat.model;
    let effort = chat.effort;
    if (foreign) {
      if (busy(foreign.status)) return null;
      // Deliver what the other client wrote last (e.g. an answer finished seconds ago) before taking over.
      await this.mirror(chatId).catch(error => this.log('mirror_error', error));
      const argv = (await readFile(`/proc/${foreign.pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
      const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
      if (!chat.modelOverride) { model = flag('--model') ?? model; effort = flag('--effort') ?? effort; }
      if (!await this.desktop.terminate(foreign)) return null;
      this.save({ id: chatId, takenOverAt: Date.now() });
    }
    runner = this.runnerFactory({ id: chatId, cwd: chat.cwd, resume: chat.started, model, effort, name: chat.title,
      onQuestion: (input, signal) => this.ask(chatId, input, signal) });
    runner.on('message', message => { void this.enqueueEvent(chatId, () => this.onClaude(chatId, runner, message)); });
    runner.on('exit', error => { void this.enqueueEvent(chatId, () => this.onExit(chatId, runner, error)); });
    this.runners.set(chatId, runner);
    const path = await this.desktop.pathFor(chatId);
    if (path) this.save({ id: chatId, mirrorOffset: await this.desktop.size(path) });
    return runner;
  }

  // Collapse the current card into its one-line summary, without buttons. Never leaves a stale ■ Стоп.
  // While background work (agents, workflows, shells) outlives the turn, the collapsed card keeps
  // a second, live line; it is finalized when the work ends or the next turn starts.
  // Card: monospace status, then what the agent said along the way, newest last, with its Markdown
  // (bold, code, lists) and line breaks, a blank line between entries. While the turn runs the log is
  // plain text; once it is over it folds into an expandable quote under the final line. The oldest
  // entries give way to the Telegram message limit.
  cardHtml(status, notes = [], { done = false } = {}) {
    const shown = [];
    let used = 0;
    for (const note of [...notes].reverse()) {
      const text = noteText(this.clean(note));
      if (used + text.length > 3000) break;
      shown.unshift(text);
      used += text.length + 2;
    }
    if (shown.length < notes.length) shown.unshift(`… ещё ${notes.length - shown.length} раньше`);
    const log = shown.map(renderTelegramHtml).join('\n\n');
    return `<pre>${escapeHtml(this.clean(status))}</pre>${!shown.length ? '' : done ? `\n<blockquote expandable>${log}</blockquote>` : `\n${log}`}`;
  }

  // Card operations of one chat run one at a time on fresh state: a late refresh can neither put
  // ■ Стоп back on a collapsed card nor send a second card for the same turn.
  cardLock(chatId, operation) { return serialize(this.cardLocks, chatId, operation); }
  closeCard(chatId) { return this.cardLock(chatId, () => this.closeCardNow(chatId)); }
  finishBackgroundCard(chatId, options) { return this.cardLock(chatId, () => this.finishBackgroundNow(chatId, options)); }
  refreshCard(chatId) { return this.cardLock(chatId, () => this.refreshCardNow(chatId)); }

  async closeCardNow(chatId) {
    const chat = this.chat(chatId);
    if (chat?.bgCardId) await this.finishBackgroundNow(chatId, { final: true });
    if (!chat?.statusMessageId) return;
    const closed = ['active', 'desktop'].includes(chat.status) ? { ...chat, status: 'idle', turnMs: chat.turnMs ?? Date.now() - (chat.turnStartedAt ?? Date.now()) } : chat;
    const live = Object.keys(chat.background ?? {}).length > 0;
    this.save({ id: chatId, statusMessageId: null, bgCardId: live ? chat.statusMessageId : null, bgCardLine: live ? finalLine({ ...closed, background: {} }, this.state.get('limits')) : null });
    if (live) return this.finishBackgroundNow(chatId);
    await this.edit(chat.statusMessageId, this.cardHtml(finalLine(closed, this.state.get('limits')), chat.notes, { done: true }), { html: true, reply_markup: { inline_keyboard: [] } }).catch(error => this.log('card_close_error', error));
  }

  // Updates the collapsed card's background line; `final` (or no background left) freezes it.
  async finishBackgroundNow(chatId, { final = false } = {}) {
    const chat = this.chat(chatId);
    if (!chat?.bgCardId) return;
    const background = await this.backgroundProgress(chat.background);
    const done = final || !Object.keys(background).length;
    const text = done ? chat.bgCardLine : `${chat.bgCardLine}\n${backgroundLine({ background })}`;
    await this.edit(chat.bgCardId, this.cardHtml(text, chat.notes, { done: true }), { html: true, reply_markup: { inline_keyboard: [] } }).catch(error => this.log('bg_card_error', error));
    if (done) this.save({ id: chatId, bgCardId: null, bgCardLine: null });
  }

  // Workflow progress from its transcript directory: agents started / agents finished.
  async backgroundProgress(background = {}) {
    const result = {};
    for (const [key, item] of Object.entries(background)) {
      result[key] = { ...item };
      if (!item.dir) continue;
      try {
        const names = await readdir(item.dir);
        const journal = await readFile(join(item.dir, 'journal.jsonl'), 'utf8').catch(() => '');
        result[key].total = names.filter(n => /^agent-.*\.meta\.json$/.test(n)).length;
        result[key].done = (journal.match(/"type":"result"/g) ?? []).length;
      } catch {}
    }
    return result;
  }
  // A background tool's result says where its transcripts live (workflows: "Transcript dir: …").
  noteBackgroundDirs(chatId, content) {
    const chat = this.chat(chatId);
    if (!Array.isArray(content) || !chat?.background) return;
    let changed = false;
    const background = { ...chat.background };
    for (const block of content) {
      if (block.type !== 'tool_result' || !background[block.tool_use_id]) continue;
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
      const dir = text.match(/Transcript dir: (\/[^\s"\\]+)/)?.[1];
      if (dir && dir.startsWith(join(this.home, '.claude', 'projects') + '/')) { background[block.tool_use_id] = { ...background[block.tool_use_id], dir }; changed = true; }
    }
    if (changed) this.save({ id: chatId, background });
  }

  async beginTurn(chatId, { trigger = null, status = 'active', at = Date.now() } = {}) {
    await this.closeCard(chatId);
    this.save({ id: chatId, status, source: status === 'desktop' ? 'desktop' : 'bot', turnStartedAt: at, action: 'думаю', actionSince: null, notes: [], agents: {}, outcome: null, error: null, turnMs: null,
      question: null, stopRequested: false, statusMessageId: null, waitDesktop: false, queuePaused: false, trigger, pendingTrigger: null });
    await this.refreshCard(chatId);
  }

  // ---------- Claude events ----------
  async onClaude(chatId, runner, m) {
    if (this.runners.get(chatId) !== runner) return;
    let chat = this.chat(chatId);
    // The CLI started a turn by itself: a background agent/shell finished and woke the session.
    if (m.type === 'assistant' && !m.parent_tool_use_id && chat.status !== 'active' && chat.started) {
      await this.beginTurn(chatId, { trigger: 'после фоновой задачи' });
      chat = this.chat(chatId);
    }
    if (m.type === 'system' && m.subtype === 'init') {
      if (m.apiKeySource !== 'none') {
        this.log('not_subscription', `apiKeySource=${m.apiKeySource}`);
        this.save({ id: chatId, status: 'idle', outcome: 'error', error: 'Claude запустился не по подписке — остановлен. Войди подпиской: claude auth login' });
        await runner.close(1000);
        return this.refreshCard(chatId);
      }
      this.save({ id: chatId, started: true, model: m.model, ...(m.effort ? { effort: m.effort } : {}) });
      return;
    }
    if (m.type === 'assistant') {
      const content = m.message?.content ?? [];
      if (m.parent_tool_use_id) {
        const agents = { ...(chat.agents ?? {}) };
        const agent = agents[m.parent_tool_use_id];
        const tool = content.find(c => c.type === 'tool_use');
        if (agent && tool) { agents[m.parent_tool_use_id] = { ...agent, lastTool: tool.name }; this.save({ id: chatId, agents }); }
        return;
      }
      const usage = m.message?.usage;
      const patch = { id: chatId };
      if (usage) patch.usage = { total: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), max: chat.usage?.max ?? contextWindow(m.message.model ?? chat.model) };
      const tools = content.filter(c => c.type === 'tool_use');
      // What the agent says along the way is shown on the card (💬); the final answer comes as its own message.
      const said = saying(content);
      if (said && m.message?.stop_reason !== 'end_turn') patch.notes = addNote(chat.notes, said);
      if (tools.length) {
        const last = tools.at(-1);
        patch.action = actionLabel(last.name, last.input);
        patch.actionSince = Date.now();
        const agents = { ...(chat.agents ?? {}) };
        const background = { ...(chat.background ?? {}) };
        for (const tool of tools) {
          const detached = Boolean(tool.input?.run_in_background) || tool.name === 'Workflow';
          if (['Agent', 'Task'].includes(tool.name) && !detached) agents[tool.id] = { name: tool.input?.subagent_type || tool.input?.description || 'agent', status: 'running', startedAt: Date.now() };
          else if (tool.name === 'Workflow') background[tool.id] = { name: backgroundName(tool), startedAt: Date.now() };
        }
        patch.background = background;
        patch.agents = agents;
      } else if (content.some(c => c.type === 'text')) patch.action = 'пишу ответ';
      this.save(patch);
      return;
    }
    if (m.type === 'user' && !m.parent_tool_use_id) { this.noteBackgroundDirs(chatId, m.message?.content); return; }
    if (m.type === 'tool_progress' && !m.parent_tool_use_id) { this.save({ id: chatId, actionSince: Date.now() - m.elapsed_time_seconds * 1000 }); return; }
    if (m.type === 'system' && m.subtype === 'task_started') {
      const key = m.tool_use_id || m.task_id;
      const shell = m.task_type === 'local_bash';
      if (m.is_backgrounded || chat.background?.[key]) {
        const name = shell ? `bash: ${cutText(m.description, 20)}` : `агент «${cutText(m.description || m.subagent_type, 20)}»`;
        this.save({ id: chatId, background: { ...(chat.background ?? {}), [key]: chat.background?.[key] ?? { name, startedAt: Date.now() } } });
      } else if (!shell && key) {
        const agents = { ...(chat.agents ?? {}) };
        agents[key] = { ...agents[key], name: m.subagent_type || agents[key]?.name || cutText(m.description, 20) || 'agent', status: 'running', startedAt: agents[key]?.startedAt ?? Date.now() };
        this.save({ id: chatId, agents });
      }
      return;
    }
    if (m.type === 'system' && m.subtype === 'task_notification') {
      const key = m.tool_use_id || m.task_id;
      const background = { ...(chat.background ?? {}) };
      delete background[key];
      const agents = chat.agents?.[key] ? { ...chat.agents, [key]: { ...chat.agents[key], status: m.status === 'completed' ? 'completed' : 'failed' } } : chat.agents;
      this.save({ id: chatId, background, agents });
      if (!['active', 'desktop'].includes(chat.status) && chat.statusMessageId === null) await this.refreshCard(chatId);
      return;
    }
    if (m.type === 'system' && m.subtype === 'status' && m.status === 'compacting') { this.save({ id: chatId, action: 'сжимаю контекст', actionSince: Date.now() }); return; }
    if (m.type === 'system' && m.subtype === 'compact_boundary') {
      this.save({ id: chatId, action: 'думаю', usage: { total: m.compact_metadata?.post_tokens ?? 0, max: chat.usage?.max ?? contextWindow(chat.model) } });
      return;
    }
    if (m.type === 'system' && m.subtype === 'api_retry') { this.save({ id: chatId, action: `повтор API ${m.attempt}/${m.max_retries}`, actionSince: Date.now() }); return; }
    if (m.type === 'rate_limit_event') { this.updateLimits(m.rate_limit_info); return; }
    if (m.type === 'result') return this.finishTurn(chatId, runner, m);
  }

  updateLimits(info) {
    const windows = info?.unifiedWindows ?? {};
    const limits = { ...this.state.get('limits', {}) };
    if (Number.isFinite(windows.five_hour?.utilization)) limits.fiveHour = windows.five_hour.utilization;
    if (Number.isFinite(windows.seven_day?.utilization)) limits.sevenDay = windows.seven_day.utilization;
    if (!windows.five_hour && info?.rateLimitType === 'five_hour' && Number.isFinite(info.utilization)) limits.fiveHour = info.utilization;
    if (!windows.seven_day && info?.rateLimitType === 'seven_day' && Number.isFinite(info.utilization)) limits.sevenDay = info.utilization;
    limits.at = Date.now();
    this.state.set('limits', limits);
  }

  async finishTurn(chatId, runner, m) {
    const text = typeof m.result === 'string' ? m.result.trim() : '';
    const failed = m.subtype !== 'success' || m.is_error;
    const key = `answer:${chatId}:${m.uuid}`;
    // Under the turn lock: a message sent right after the answer starts its turn only after this one is closed.
    await this.withTurnLock(chatId, async () => {
      if (!failed && text) {
        try { await this.deliverAnswer(chatId, text, key, { artifacts: false }); }
        catch (error) {
          this.log('answer_error', error);
          await delay(3000);
          await this.deliverAnswer(chatId, text, key, { artifacts: false })
            .catch(async again => { this.log('answer_error', again); await this.say(chatId, '✗ ответ не доставлен в Telegram, он сохранён в сессии').catch(() => {}); });
        }
      }
      await this.settleTurn(chatId, runner, m, failed, text);
    });
    if (!failed && text) await this.sendArtifacts(chatId, text, key).catch(error => this.log('artifact_error', error));
    if (this.chat(chatId)?.outcome === 'ok' && this.chat(chatId)?.status === 'idle') void this.runQueued(chatId);
  }

  async settleTurn(chatId, runner, m, failed, text) {
    const chat = this.chat(chatId);
    if (m.queued_turn_count > 0) { this.save({ id: chatId, turnStartedAt: Date.now(), action: 'думаю', actionSince: null }); return; }
    let usage = chat.usage;
    try {
      const context = await runner.contextUsage();
      if (context?.maxTokens) usage = { total: context.totalTokens, max: context.maxTokens };
    } catch (error) { this.log('context_error', error); }
    const outcome = chat.stopRequested ? 'stopped' : failed ? 'error' : 'ok';
    const error = failed ? this.clean((m.errors?.join('; ') || text || m.subtype)).slice(0, 200) : null;
    this.save({ id: chatId, status: 'idle', outcome, error, usage, turnMs: m.duration_ms ?? Date.now() - (chat.turnStartedAt ?? Date.now()),
      action: null, question: null, stopRequested: false, lastTurnAt: Date.now(), ...(outcome !== 'ok' ? { queuePaused: true } : {}) });
    await this.closeCard(chatId);
    this.save({ id: chatId, trigger: null });
    // Not awaited: the title takes a few seconds and must not hold the turn lock.
    if (outcome === 'ok') void this.aiTitle(chatId, text).catch(error => this.log('title_error', error));
    if (this.chat(chatId).projectLineId) {
      await this.edit(this.chat(chatId).projectLineId, `📁 ${this.chat(chatId).project}`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      this.save({ id: chatId, projectLineId: null });
    }
  }

  async onExit(chatId, runner, error) {
    if (this.runners.get(chatId) === runner) this.runners.delete(chatId);
    if (error) this.log('runner_exit', error);
    if (this.stopping) return;
    const chat = this.chat(chatId);
    if (chat?.status === 'active' && this.runners.get(chatId) === undefined) {
      this.save({ id: chatId, status: 'idle', outcome: chat.stopRequested ? 'stopped' : 'error', error: error ? this.clean(error.message).slice(0, 200) : 'процесс Claude завершился', turnMs: Date.now() - (chat.turnStartedAt ?? Date.now()) });
        await this.refreshCard(chatId);
    }
  }

  // After the first successful turn a chat started in the bot gets a short title (2–5 words) instead
  // of the start of its first message; one attempt per chat. Desktop sessions keep the app's title.
  async aiTitle(chatId, answer = '') {
    const chat = this.chat(chatId);
    if (!this.titler || chat.aiTitled || chat.origin !== 'bot' || chat.topicNamedBy === 'user') return;
    this.save({ id: chatId, aiTitled: true });
    const request = (chat.firstMessages ?? []).map(m => m.text ?? m.caption ?? '').filter(Boolean).join('\n') || chat.title;
    const title = await this.titler(`Запрос: ${request}${answer ? `\n\nНачало ответа: ${String(answer).slice(0, 500)}` : ''}`);
    if (!title) return;
    this.save({ id: chatId, title });
    await this.renameTopic(chatId, title);
  }
  // ---------- delivery ----------
  async deliverAnswer(chatId, text, key, { artifacts = true, recreate = true } = {}) {
    if (!this.state.wasDelivered(key)) {
      const display = this.clean(text).replace(/!?\[([^\]\n]*)\]\(<?\/[^\n)]+?>?\)/g, '$1 (файл ниже)');
      await this.sendToChat(chatId, async topicId => {
        const messages = await this.api.sendAnswer(this.ownerId, display, { message_thread_id: topicId });
        for (const message of messages) if (message?.message_id) this.state.bind(message.message_id, chatId);
      }, { recreate });
      this.state.delivered(key);
    }
    if (artifacts) await this.sendArtifacts(chatId, text, key, { recreate });
  }

  async sendArtifacts(chatId, text, key, { recreate = true } = {}) {
    const paths = [...String(text).matchAll(/\]\(<?(\/[^\n)]+?)>?(?:\s+"[^"\n]*")?\)/g)].map(m => m[1].replace(/:\d+$/, ''));
    for (const path of [...new Set(paths)].slice(0, 12)) {
      const deliveryKey = `${key}:file:${path}`;
      if (this.state.wasDelivered(deliveryKey)) continue;
      try {
        const snapshotId = this.state.get(`artifact:${deliveryKey}`);
        let file = snapshotId ? this.state.file(snapshotId) : null;
        if (!file) {
          const resolved = await this.safeArtifact(path);
          if (!resolved) {
            await this.say(chatId, `✗ файл ${basename(path)} не отправлен: его нет на машине или он закрыт для отправки`, { recreate }).catch(() => {});
            this.state.delivered(deliveryKey);
            continue;
          }
          const info = await stat(resolved);
          if (!this.api.local && info.size > CLOUD_UPLOAD_LIMIT) {
            await this.say(chatId, `✗ файл ${basename(resolved)} больше 50 МБ — облачный Telegram Bot API не отправит его. Он лежит на машине: ${resolved}`, { recreate }).catch(() => {});
            this.state.delivered(deliveryKey);
            continue;
          }
          const dir = join(this.dataDir, 'files', chatId, 'outputs');
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const storage = await statfs(dir);
          if (storage.bavail * storage.bsize < info.size * 2 + 512 * 1024 * 1024) throw new Error('мало места на диске');
          const snapshot = join(dir, `${randomUUID()}__${safeFilename(basename(resolved))}`);
          await copyFile(resolved, snapshot, constants.COPYFILE_EXCL);
          await chmod(snapshot, 0o600);
          if (!await this.safeArtifact(snapshot)) { await unlink(snapshot); continue; }
          file = this.state.addFile(chatId, { path: snapshot, originalPath: resolved, name: basename(resolved), size: info.size, direction: 'out' });
          this.state.set(`artifact:${deliveryKey}`, file.id);
        }
        const safePath = await this.safeArtifact(file.path);
        if (!safePath) continue;
        const message = await this.sendToChat(chatId, topicId => this.sendMedia(safePath, file.size, file.name, topicId), { recreate });
        if (!message?.message_id) continue;
        this.state.bind(message.message_id, chatId);
        this.state.delivered(deliveryKey);
      } catch (error) {
        this.log('artifact_error', error);
        await this.say(chatId, `✗ файл ${basename(path)} не отправлен, он остаётся на машине`, { recreate }).catch(() => {});
      }
    }
  }

  // Copies of files sent to Telegram: the file is in the chat and the original where the agent made it.
  // After 14 days the copy goes, and with it its /files entry.
  async pruneOutputs() {
    const root = join(this.dataDir, 'files');
    const cutoff = Date.now() - OUTPUT_KEEP_MS;
    try {
      for (const chat of await readdir(root).catch(() => [])) {
        const dir = join(root, chat, 'outputs');
        for (const name of await readdir(dir).catch(() => [])) {
          const info = await stat(join(dir, name)).catch(() => null);
          if (info?.isFile() && info.mtimeMs < cutoff) await unlink(join(dir, name));
        }
      }
      for (const file of this.state.outputFiles()) if (!await stat(file.path).catch(() => null)) this.state.dropFile(file.id);
    } catch (error) { this.log('prune_error', error); }
  }

  async safeArtifact(path) {
    const resolved = await realpath(path).catch(() => null);
    if (!resolved) return null;
    if (/\/\.ssh\/|\/telegram-bot-api\/|\/\.claude\/sessions\/|\/\.claude\/\.credentials\.json$|\/\.codex\/auth\.json$/.test(resolved)
      || /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|id_rsa|id_ed25519|\.credentials\.json)$/.test(resolved)) return null;
    const info = await stat(resolved);
    if (!info.isFile() || info.size > 2_000_000_000) return null;
    if (info.size < 1_000_000) {
      const content = await readFile(resolved);
      if (this.secrets.some(s => s && content.includes(Buffer.from(s)))) return null;
    }
    return resolved;
  }

  async sendMedia(path, size, name, topicId) {
    const options = { caption: name.slice(0, 200), filename: name, ...(topicId ? { message_thread_id: topicId } : {}) };
    const extension = extname(path).toLowerCase();
    let method;
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension) && size <= 10_000_000) method = 'sendPhoto';
    else if (extension === '.mp4') method = 'sendVideo';
    else if (extension === '.gif') method = 'sendAnimation';
    else if (['.mp3', '.m4a'].includes(extension)) method = 'sendAudio';
    else if (['.ogg', '.opus'].includes(extension)) method = 'sendVoice';
    if (method) {
      try { return await this.api[method](this.ownerId, path, { ...options, ...(method === 'sendVideo' ? { supports_streaming: true } : {}) }); }
      catch (error) { if (error.code !== 400 || topicGone(error)) throw error; this.log('media_preview_fallback', error); }
    }
    return this.api.sendDocument(this.ownerId, path, options);
  }

  // ---------- card ----------
  cardMarkup(chat) {
    return ['active', 'desktop'].includes(chat.status)
      ? { inline_keyboard: [[this.button('■ Стоп', 'stop', { chatId: chat.id }, 'danger')]] } : { inline_keyboard: [] };
  }
  async refreshCardNow(chatId) {
    const chat = this.chat(chatId);
    if (!chat || !chat.turnStartedAt) return;
    const shown = { ...chat, background: await this.backgroundProgress(chat.background) };
    const live = ['active', 'desktop'].includes(chat.status);
    const text = this.cardHtml(cardText(shown, { limits: this.state.get('limits'), queued: this.state.queuedTurns(chatId).length }), chat.notes, { done: !live });
    const reply_markup = this.cardMarkup(chat);
    if (chat.statusMessageId) {
      try { await this.edit(chat.statusMessageId, text, { html: true, reply_markup }); return; }
      catch (error) { if (!/message to edit not found|message can't be edited/i.test(error.message)) { this.log('card_edit_error', error); return; } }
    }
    if (!['active', 'desktop'].includes(chat.status)) return;
    const [message] = await this.sendToChat(chatId, topicId => this.send(text, { topicId, chatId, reply_markup, html: true }), { recreate: chat.status === 'active' });
    if (message) this.save({ id: chatId, statusMessageId: message.message_id });
  }
  async refreshCards() {
    if (this.cardsBusy || this.stopping) return;
    this.cardsBusy = true;
    try {
      for (const chat of this.state.chats().filter(c => ['active', 'desktop'].includes(c.status))) await this.refreshCard(chat.id).catch(error => this.log('card_error', error));
      for (const chat of this.state.chats().filter(c => c.bgCardId && !['active', 'desktop'].includes(c.status))) await this.finishBackgroundCard(chat.id).catch(error => this.log('card_error', error));
    }
    finally { this.cardsBusy = false; }
  }

  // ---------- desktop mirror ----------
  // Transcript records written by other clients (desktop app, terminal) are mirrored into the
  // chat's topic: the prompt, live action on the card, and the final answer.
  async pollMirrors() {
    if (this.mirrorBusy || this.stopping) return;
    this.mirrorBusy = true;
    try {
      for (const chat of this.state.chats().filter(c => c.topicId && c.started && !c.archived)) {
        try { await this.mirror(chat.id); } catch (error) { this.log('mirror_error', error); }
      }
    } finally { this.mirrorBusy = false; }
  }
  // One pass per chat at a time (the timer and a takeover may both ask); each reads the saved offset afresh.
  mirror(chatId) { return serialize(this.mirrors, chatId, () => this.mirrorNow(chatId)); }
  async mirrorNow(chatId) {
    const chat = this.chat(chatId);
    if (!chat) return;
    const path = await this.desktop.pathFor(chat.id);
    if (!path) return;
    if (chat.mirrorOffset == null) { this.save({ id: chat.id, mirrorOffset: await this.desktop.size(path) }); return; }
    const { records, offset } = await this.desktop.read(path, chat.mirrorOffset);
    if (offset !== chat.mirrorOffset) this.save({ id: chat.id, mirrorOffset: offset });
    const foreign = records.filter(r => r.entrypoint && r.entrypoint !== 'sdk-ts' && !r.isSidechain);
    if (foreign.length) {
      const runner = this.runners.get(chat.id);
      // Its in-memory conversation is stale now; closed under the turn lock (not awaited: a takeover holds it).
      if (runner?.alive && !runner.active) void this.retire(chat.id, runner).catch(error => this.log('idle_close_error', error));
    }
    for (const record of foreign) {
      const current = this.chat(chat.id);
      const at = Date.parse(record.timestamp) || Date.now();
      const note = taskNotification(record);
      if (note) {
        const background = { ...(current.background ?? {}) };
        if (note.toolUseId) delete background[note.toolUseId];
        const agents = note.toolUseId && current.agents?.[note.toolUseId]
          ? { ...current.agents, [note.toolUseId]: { ...current.agents[note.toolUseId], status: note.status === 'completed' ? 'completed' : 'failed' } } : current.agents;
        this.save({ id: chat.id, background, agents, pendingTrigger: true });
        continue;
      }
      const prompt = userPrompt(record);
      if (prompt) {
        await this.sendHtml(chat.id, `💻 <blockquote expandable>${escapeHtml(this.clean(Array.from(prompt).slice(0, 1500).join('')))}</blockquote>`, { recreate: false })
          .catch(() => this.say(chat.id, `💻 ${prompt.slice(0, 1500)}`, { recreate: false }));
        if (!this.chat(chat.id)?.topicId) return;
        // A message typed during a running turn only corrects it: same card, no new one.
        if (current.status !== 'desktop') await this.beginTurn(chat.id, { status: 'desktop', at });
        continue;
      }
      if (record.type === 'user' && Array.isArray(record.message?.content)) {
        this.noteBackgroundDirs(chat.id, record.message.content);
        const agents = { ...(this.chat(chat.id).agents ?? {}) };
        let changed = false;
        for (const block of record.message.content) {
          if (block.type === 'tool_result' && agents[block.tool_use_id]?.status === 'running') { agents[block.tool_use_id] = { ...agents[block.tool_use_id], status: block.is_error ? 'failed' : 'completed' }; changed = true; }
        }
        if (changed) this.save({ id: chat.id, agents });
        continue;
      }
      if (record.type !== 'assistant') continue;
      if (current.status !== 'desktop') await this.beginTurn(chat.id, { status: 'desktop', at, trigger: current.pendingTrigger ? 'после фоновой задачи' : 'продолжение' });
      const turn = this.chat(chat.id);
      const patch = { id: chat.id };
      if (record.message?.model) patch.model = record.message.model;
      const usage = record.message?.usage;
      if (usage) patch.usage = { total: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), max: contextWindow(record.message.model ?? turn.model) };
      const tools = (record.message?.content ?? []).filter(c => c.type === 'tool_use');
      const said = saying(record.message?.content);
      if (said && record.message?.stop_reason !== 'end_turn') patch.notes = addNote(turn.notes, said);
      if (tools.length) {
        const last = tools.at(-1);
        patch.action = actionLabel(last.name, last.input);
        patch.actionSince = at;
        const agents = { ...(turn.agents ?? {}) };
        const background = { ...(turn.background ?? {}) };
        for (const tool of tools) {
          const detached = Boolean(tool.input?.run_in_background) || tool.name === 'Workflow';
          if (['Agent', 'Task'].includes(tool.name) && !detached) agents[tool.id] = { name: tool.input?.subagent_type || cutText(tool.input?.description, 20) || 'agent', status: 'running', startedAt: at };
          else if (['Agent', 'Task', 'Workflow'].includes(tool.name) || (tool.name === 'Bash' && detached)) background[tool.id] = { name: backgroundName(tool), startedAt: at };
        }
        patch.agents = agents;
        patch.background = background;
      }
      this.save(patch);
      const text = assistantText(record);
      if (text && record.message?.stop_reason === 'end_turn') {
        await this.deliverAnswer(chat.id, text, `answer:${chat.id}:${record.uuid}`, { recreate: false });
        const done = this.chat(chat.id);
        this.save({ id: chat.id, status: 'idle', outcome: 'ok', turnMs: at - (done.turnStartedAt ?? at), action: null });
        await this.closeCard(chat.id);
        this.save({ id: chat.id, trigger: null });
      }
    }
    // No transcript activity: settle a turn whose process ended, stop waiting, drop orphaned background.
    const now = this.chat(chat.id);
    if (now.waitDesktop || now.status === 'desktop' || Object.keys(now.background ?? {}).length) {
      const live = await this.desktop.foreign(chat.id);
      const ours = this.runners.get(chat.id)?.alive;
      if (!live && !ours && Object.keys(now.background ?? {}).length) this.save({ id: chat.id, background: {} });
      if (!foreign.length && (!live || !busy(live.status))) {
        if (now.status === 'desktop' && Date.now() - (now.actionSince ?? now.turnStartedAt ?? 0) > 20000) {
          this.save({ id: chat.id, status: 'idle', outcome: 'ok', turnMs: Date.now() - (now.turnStartedAt ?? Date.now()) });
          await this.closeCard(chat.id);
          this.save({ id: chat.id, trigger: null });
        }
        if (now.waitDesktop) { this.save({ id: chat.id, waitDesktop: false }); void this.runQueued(chat.id); }
      }
    }
  }

  async closeIdle() {
    for (const [chatId, runner] of this.runners) {
      if (!runner.active && Date.now() - runner.lastActivity > IDLE_CLOSE_MS && ![...this.questions.values()].some(q => q.chatId === chatId)
        && !Object.keys(this.chat(chatId)?.background ?? {}).length) {
        await this.retire(chatId, runner).catch(error => this.log('idle_close_error', error));
      }
    }
  }

  // ---------- queue ----------
  async runQueued(chatId) {
    const chat = this.chat(chatId);
    if (!chat || chat.queuePaused || this.stopping) return;
    const item = this.state.queuedTurns(chatId).find(i => i.status === 'waiting');
    if (!item) return;
    await this.withTurnLock(chatId, async () => {
      // A pending result is closed by finishTurn, which starts the queue again.
      if (this.state.queueItem(item.id)?.status !== 'waiting' || this.runners.get(chatId)?.active || this.resultPending(chatId)) return;
      const runner = await this.ensureRunner(chatId);
      if (!runner) { this.save({ id: chatId, waitDesktop: true }); return; }
      this.state.queueStatus(item.id, 'dispatching');
      await this.beginTurn(chatId);
      runner.push(item.input);
      this.state.queueStatus(item.id, 'sent');
    });
  }

  // ---------- questions ----------
  async ask(chatId, input, signal) {
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    if (!questions.length) return null;
    const key = randomBytes(6).toString('base64url');
    const q = { key, chatId, questions, answers: {}, selected: {}, messages: [] };
    this.save({ id: chatId, question: true });
    const answered = new Promise(resolve => { q.resolve = resolve; });
    this.questions.set(key, q);
    const cleanup = () => { this.questions.delete(key); this.save({ id: chatId, question: null }); };
    signal?.addEventListener('abort', () => { cleanup(); q.resolve(null); }, { once: true });
    try {
      for (const [index, item] of questions.entries()) {
        const rows = (item.options ?? []).map((option, i) => [this.button(option.label, item.multiSelect ? 'answer_toggle' : 'answer', { key, index, option: i })]);
        if (item.multiSelect) rows.push([this.button('Готово', 'answer_done', { key, index })]);
        const options = (item.options ?? []).filter(o => o.description).map(o => `• ${o.label} — ${o.description}`).join('\n');
        const [message] = await this.say(chatId, `❓ **${item.header ? `${item.header}: ` : ''}${item.question}**${options ? `\n${options}` : ''}`, { reply_markup: { inline_keyboard: rows } });
        q.messages[index] = message?.message_id;
      }
      await this.refreshCard(chatId).catch(() => {});
      return await answered;
    } catch (error) {
      this.log('question_error', error);
      return null;
    } finally { cleanup(); }
  }
  async settle(q, index, answer) {
    q.answers[q.questions[index].question] = answer;
    if (q.messages[index]) await this.edit(q.messages[index], `❓ ${q.questions[index].question}\n→ ${answer}`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (q.questions.every(item => q.answers[item.question] !== undefined)) q.resolve(q.answers);
  }
  async answerFree(q, text, messageId) {
    const index = q.questions.findIndex(item => q.answers[item.question] === undefined);
    if (index < 0) return;
    await this.react(messageId, '👀');
    await this.settle(q, index, text);
  }

  // ---------- stop ----------
  async stopTurn(chatId) {
    const chat = this.chat(chatId);
    if (!chat) return;
    if (this.media.has(chatId) || this.runners.get(chatId)?.active || ['active', 'desktop'].includes(chat.status)) this.save({ id: chatId, queuePaused: true });
    this.media.get(chatId)?.controller.abort();
    for (const q of this.questions.values()) if (q.chatId === chatId) q.resolve(null);
    const runner = this.runners.get(chatId);
    if (runner?.active) {
      this.save({ id: chatId, stopRequested: true, action: 'останавливаю' });
      await runner.interrupt().catch(error => this.log('interrupt_error', error));
      await this.refreshCard(chatId);
      return;
    }
    const foreign = await this.desktop.foreign(chatId);
    if (foreign && busy(foreign.status)) {
      try { process.kill(foreign.pid, 'SIGTERM'); } catch {}
      this.save({ id: chatId, status: 'idle', outcome: 'stopped', turnMs: Date.now() - (chat.turnStartedAt ?? Date.now()) });
      await this.refreshCard(chatId);
      return this.say(chatId, '■ процесс на компьютере остановлен');
    }
  }

  // ---------- commands ----------
  async control(command, { topicId, chatId, message }) {
    const name = command.name;
    if (name === 'start' || name === 'help') {
      if (chatId) return this.showContext(chatId, topicId);
      return this.send('**Claude**\nЧат = тема. Пиши в тему — продолжу там.', { reply_markup: { inline_keyboard: [[this.button('＋ Новый чат', 'new', {}), this.button('Сессии', 'sessions', { page: 0 })]] } });
    }
    if (name === 'new') {
      const chat = chatId ? this.chat(chatId) : null;
      // Telegram's «Новый чат» creates a topic and sends /new into it: that topic already is the new chat.
      if (chat && !chat.started && chat.untitled) return;
      if (!chat && topicId) return this.startDefaultChat({ topicId });
      if (chat) { const created = await this.createChat(projectFor(this.projects, chat.cwd)); return this.say(created.id, 'Напиши задачу.'); }
      return this.send('Новый чат в:', { topicId, reply_markup: { inline_keyboard: await this.projectRows({ mode: 'new' }) } });
    }
    if (name === 'sessions') return this.send('Сессии', { topicId, reply_markup: { inline_keyboard: await this.sessionRows(0) } });
    if (name === 'model') return this.send(await this.modelText(chatId), { topicId, reply_markup: { inline_keyboard: this.modelRows(chatId) } });
    if (name === 'stop') {
      if (chatId) return this.stopTurn(chatId);
      const active = this.state.chats().filter(c => ['active', 'desktop'].includes(c.status));
      if (!active.length) return this.send('Нет активной работы.');
      return this.send('Остановить:', { reply_markup: { inline_keyboard: active.map(c => [this.button(`■ ${c.project} · ${c.title.slice(0, 40)}`, 'stop', { chatId: c.id }, 'danger')]) } });
    }
    if (!chatId) return this.send('Открой тему чата.', { topicId });
    if (name === 'queue') return this.showQueue(chatId);
    if (name === 'files') return this.showFiles(chatId);
    if (name === 'context') return this.showContext(chatId, topicId);
    if (name === 'compact') {
      const runner = this.runners.get(chatId);
      if (runner?.active || this.chat(chatId).status === 'desktop') return this.say(chatId, 'Дождись конца хода.');
      return this.dispatch(chatId, [{ type: 'text', text: '/compact' }], message?.message_id);
    }
    if (name === 'archive') return this.say(chatId, 'Архивировать чат? Тема удалится, история сессии останется на машине.', { reply_markup: { inline_keyboard: [[this.button('Архивировать', 'archive', { chatId }, 'danger')]] } });
  }

  async recentProjects(limit = 6) {
    const seen = new Map();
    for (const chat of this.state.chats().filter(c => !c.archived)) seen.set(chat.cwd, Math.max(seen.get(chat.cwd) ?? 0, chat.lastTurnAt ?? chat.created ?? 0));
    for (const session of await this.desktop.list({ limit: 60 }).catch(() => [])) seen.set(session.cwd, Math.max(seen.get(session.cwd) ?? 0, session.lastActivity));
    const recent = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([cwd]) => projectFor(this.projects, cwd));
    const main = this.defaultProject().path;
    for (const project of [...this.projects].sort((a, b) => (b.path === main) - (a.path === main) || a.label.localeCompare(b.label))) {
      if (recent.length >= limit) break;
      if (!recent.some(p => p.path === project.path)) recent.push(project);
    }
    return recent.slice(0, limit);
  }
  async projectRows({ mode, page = null, chatId = null }) {
    const list = page === null ? await this.recentProjects() : [...this.projects].sort((a, b) => a.label.localeCompare(b.label)).slice(page * 8, page * 8 + 8);
    const rows = list.map(p => [this.button(p.label, 'pick', { path: p.path, mode, chatId })]);
    const nav = [];
    if (page === null) nav.push(this.button('Все проекты', 'projects', { mode, chatId, page: 0 }));
    else {
      if (page > 0) nav.push(this.button('←', 'projects', { mode, chatId, page: page - 1 }));
      if ((page + 1) * 8 < this.projects.length) nav.push(this.button('→', 'projects', { mode, chatId, page: page + 1 }));
      nav.push(this.button('Недавние', 'projects', { mode, chatId, page: null }));
    }
    rows.push(nav);
    return rows;
  }
  async sessionRows(page) {
    const live = await this.desktop.live().catch(() => []);
    const sessions = (await this.desktop.list({ limit: 60 })).filter(s => s.entrypoint !== 'sdk-ts' || this.chat(s.sessionId)).slice(0, 48);
    const rows = sessions.slice(page * 8, page * 8 + 8).map(s => {
      const proc = live.find(p => p.sessionId === s.sessionId);
      const running = this.runners.get(s.sessionId)?.active || busy(proc?.status);
      const icon = running ? '▶' : proc && !proc.ours ? '💻' : '·';
      const label = `${icon} ${projectFor(this.projects, s.cwd).label} · ${(this.chat(s.sessionId)?.title || s.title || 'сессия').replace(/\s+/g, ' ').slice(0, 34)} · ${age(Date.now() - s.lastActivity)}`;
      return [this.button(label, 'open', { sessionId: s.sessionId })];
    });
    const nav = [];
    if (page > 0) nav.push(this.button('←', 'sessions', { page: page - 1 }));
    if ((page + 1) * 8 < sessions.length) nav.push(this.button('→', 'sessions', { page: page + 1 }));
    nav.push(this.button('＋ Новый чат', 'new', {}));
    rows.push(nav);
    return rows;
  }

  async modelText(chatId) {
    const chat = chatId ? this.chat(chatId) : null;
    const model = chat?.model ?? this.state.get('defaultModel') ?? this.defaults.model;
    const effort = chat?.effort ?? this.state.get('defaultEffort') ?? this.defaults.effort;
    return `${chat ? 'Модель чата' : 'Модель новых чатов'}: ${shortModel(model)} · ${effort ?? '—'}`;
  }
  modelRows(chatId) {
    const newest = new Map();
    for (const m of this.models().filter(m => m.value !== 'default')) {
      const family = FAMILIES.find(f => (m.resolved ?? m.value).includes(f));
      if (family && !newest.has(family)) newest.set(family, m);
    }
    const label = m => { const [family, version] = shortModel(m.resolved ?? '').split('-'); return m.resolved ? `${family[0].toUpperCase()}${family.slice(1)} ${version ?? ''}`.trim() : m.displayName || m.value; };
    return FAMILIES.filter(f => newest.has(f)).map(f => [this.button(label(newest.get(f)), 'model', { chatId, model: newest.get(f).value })]);
  }

  async showQueue(chatId) {
    const chat = this.chat(chatId);
    const items = this.state.queuedTurns(chatId);
    const rows = items.filter(i => i.status !== 'dispatching').slice(0, 8).map(i => [this.button(`✕ ${i.preview.slice(0, 40)}`, 'queue_remove', { chatId, itemId: i.id })]);
    if (items.length) rows.push([this.button(chat.queuePaused ? '▶ Продолжить' : '⏸ Пауза', chat.queuePaused ? 'queue_resume' : 'queue_pause', { chatId })]);
    return this.say(chatId, items.length ? `Очередь ${items.length}${chat.queuePaused ? ' · пауза' : ''}` : 'Очередь пуста. /queue текст — добавить.', { reply_markup: { inline_keyboard: rows } });
  }
  async showFiles(chatId) {
    const files = this.state.files(chatId);
    if (!files.length) return this.say(chatId, 'Файлов нет.');
    return this.say(chatId, `Файлы ${files.length}`, { reply_markup: { inline_keyboard: files.slice(0, 20).map(f => [this.button(`${f.direction === 'out' ? '📤' : '📎'} ${f.name}`, 'file', { fileId: f.id })]) } });
  }
  async showContext(chatId) {
    const chat = this.chat(chatId);
    const runner = this.runners.get(chatId);
    let usage = chat.usage;
    if (runner?.alive) { const context = await runner.contextUsage().catch(() => null); if (context?.maxTokens) usage = { total: context.totalTokens, max: context.maxTokens }; }
    const foreign = await this.desktop.foreign(chatId);
    const limits = this.state.get('limits', {});
    const lines = [
      `${shortModel(chat.model)} · ${chat.effort ?? '—'}`,
      usage?.max ? `контекст ${Math.round(usage.total / usage.max * 100)}% · ${tokens(usage.total)}/${tokens(usage.max)}` : 'контекст —',
      `папка ${chat.cwd}`,
      `процесс ${runner?.alive ? `бот${runner.active ? ' · работает' : ''}` : foreign ? `компьютер · ${foreign.status ?? '?'}` : 'нет'}`,
      Number.isFinite(limits.fiveHour) ? `лимит 5ч ${Math.round(limits.fiveHour * 100)}% · 7д ${Math.round((limits.sevenDay ?? 0) * 100)}%` : null,
      `сессия ${chat.id}`,
    ].filter(Boolean);
    return this.say(chatId, `\`\`\`\n${lines.join('\n')}\n\`\`\``);
  }

  // Move a chat to another project inside the same topic. Before the first turn only the folder
  // changes; after it the running work stops, a new chat in the chosen project takes the topic
  // and the first request is sent there again. The old session stays on disk (archived here).
  async moveChat(chatId, project, lineId) {
    const chat = this.chat(chatId);
    if (!chat || chat.archived || !chat.topicId) return;
    const done = async id => {
      const moved = this.chat(id);
      if (lineId) await this.edit(lineId, `📁 ${moved.project}`, { reply_markup: { inline_keyboard: [[this.button('сменить проект', 'move', { chatId: id })]] } }).catch(() => {});
      this.save({ id, projectLineId: lineId ?? moved.projectLineId });
      const icon = this.iconFor(moved);
      if (icon) await this.api.request('editForumTopic', { chat_id: this.ownerId, message_thread_id: moved.topicId, icon_custom_emoji_id: icon }).catch(() => {});
      await this.renameTopic(id, moved.title);
    };
    if (project.path === chat.cwd) return done(chatId);
    const runner = this.runners.get(chatId);
    if (!chat.started && !runner) {
      this.save({ id: chatId, cwd: project.path, project: project.label });
      return done(chatId);
    }
    await this.withTurnLock(chatId, async () => {
      if (runner) { this.runners.delete(chatId); if (runner.active) await runner.interrupt().catch(() => {}); await runner.close().catch(() => {}); }
        await this.closeCard(chatId);
    });
    const topicId = chat.topicId;
    // Requests queued for the old chat would never run: cancel them (the first request is resent below).
    for (const item of this.state.queuedTurns(chatId)) this.state.cancelQueued(item.id, chatId);
    this.save({ id: chatId, archived: true, topicId: null, status: 'idle', projectLineId: null });
    const next = this.newChatRecord(project, { title: chat.title });
    this.state.bindTopic(topicId, next.id);
    this.save({ id: next.id, topicId, topicNamedBy: chat.topicNamedBy, untitled: chat.untitled });
    await done(next.id);
    // Resend the first request through the durable update queue (never block the poller on a download).
    for (const [i, message] of (chat.firstMessages ?? []).entries()) this.state.enqueue({ update_id: -(Date.now() * 100 + i), message }, next.id);
    this.drain();
  }

  // ---------- callbacks ----------
  async callback(query) {
    const action = query.data?.startsWith('a:') ? this.state.get(`action:${query.data.slice(2)}`) : null;
    if (!action) return this.api.request('answerCallbackQuery', { callback_query_id: query.id, text: 'Кнопка устарела' }).catch(() => {});
    await this.api.request('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
    const d = action.data;
    const messageId = query.message?.message_id;
    const topicId = query.message?.message_thread_id && query.message.is_topic_message ? query.message.message_thread_id : null;
    const editMenu = (text, rows) => this.edit(messageId, text, { reply_markup: { inline_keyboard: rows } });
    switch (action.type) {
      case 'new': return editMenu('Новый чат в:', await this.projectRows({ mode: 'new' }));
      case 'projects': return editMenu(d.mode === 'move' ? 'Проект:' : 'Новый чат в:', await this.projectRows({ mode: d.mode, chatId: d.chatId, page: d.page }));
      case 'move': {
        const chat = this.chat(d.chatId);
        if (!chat || chat.archived) return editMenu('Чат уже закрыт.', []);
        return editMenu(`📁 ${chat.project} → проект:`, await this.projectRows({ mode: 'move', chatId: d.chatId }));
      }
      case 'pick': {
        const project = projectFor(this.projects, d.path);
        if (d.mode === 'move') return this.moveChat(d.chatId, project, messageId);
        const chat = await this.createChat(project);
        await editMenu(`→ «${topicName(project.label, chat.title)}»`, []);
        await this.say(chat.id, 'Напиши задачу.');
        return;
      }
      case 'sessions': return editMenu('Сессии', await this.sessionRows(d.page ?? 0));
      case 'open': {
        const chat = await this.openSession(d.sessionId);
        if (messageId && !topicId) await editMenu(`→ «${topicName(chat.project, chat.title)}»`, [[this.button('Сессии', 'sessions', { page: 0 })]]);
        return;
      }
      case 'stop': return this.stopTurn(d.chatId);
      case 'model': {
        const model = this.models().find(m => m.value === d.model);
        const efforts = model?.efforts?.length === 0 ? [] : effortsOf(model);
        if (!efforts.length) return this.callback({ ...query, data: this.button('', 'effort', { chatId: d.chatId, model: d.model, effort: null }).callback_data });
        const buttons = efforts.map(e => this.button(e, 'effort', { chatId: d.chatId, model: d.model, effort: e }));
        return editMenu(`${model?.displayName ?? d.model} · effort:`, [buttons.slice(0, 3), buttons.slice(3)].filter(r => r.length));
      }
      case 'effort': {
        if (d.chatId) {
          this.save({ id: d.chatId, model: d.model, effort: d.effort, modelOverride: true });
          const runner = this.runners.get(d.chatId);
          if (runner?.alive && !runner.active) await this.retire(d.chatId, runner);
          else if (runner?.alive) { await runner.setModel(d.model).catch(() => {}); await runner.setEffort(d.effort).catch(() => {}); }
        } else { this.state.set('defaultModel', d.model); this.state.set('defaultEffort', d.effort); }
        return editMenu(`${d.chatId ? 'Модель чата' : 'Модель новых чатов'}: ${shortModel(d.model)}${d.effort ? ` · ${d.effort}` : ''}`, []);
      }
      case 'answer': case 'answer_toggle': case 'answer_done': {
        const q = this.questions.get(d.key);
        if (!q) return editMenu('Вопрос закрыт.', []);
        const item = q.questions[d.index];
        if (action.type === 'answer') return this.settle(q, d.index, item.options[d.option].label);
        if (action.type === 'answer_toggle') {
          const set = new Set(q.selected[d.index] ?? []);
          set.has(d.option) ? set.delete(d.option) : set.add(d.option);
          q.selected[d.index] = [...set];
          const rows = item.options.map((o, i) => [this.button(`${set.has(i) ? '☑' : '☐'} ${o.label}`, 'answer_toggle', { key: d.key, index: d.index, option: i })]);
          rows.push([this.button('Готово', 'answer_done', { key: d.key, index: d.index })]);
          return this.edit(messageId, `❓ **${item.question}**`, { reply_markup: { inline_keyboard: rows } });
        }
        return this.settle(q, d.index, (q.selected[d.index] ?? []).map(i => item.options[i].label).join(', ') || '—');
      }
      case 'queue_remove': this.state.cancelQueued(d.itemId, d.chatId); return this.showQueue(d.chatId);
      case 'queue_pause': this.save({ id: d.chatId, queuePaused: true }); return this.showQueue(d.chatId);
      case 'queue_resume': this.save({ id: d.chatId, queuePaused: false }); await this.showQueue(d.chatId); return this.runQueued(d.chatId);
      case 'file': {
        const file = this.state.file(d.fileId);
        const safePath = file && await this.safeArtifact(file.path);
        if (!safePath) return this.send('✗ файл недоступен', { topicId });
        const message = await this.sendToChat(file.threadId, t => this.api.sendDocument(this.ownerId, safePath, { caption: file.name, filename: file.name, message_thread_id: t }));
        this.state.bind(message.message_id, file.threadId);
        return;
      }
      case 'archive': {
        const chat = this.chat(d.chatId);
        if (!chat) return;
        // Under the turn lock: a message dispatched at the same moment either runs first or finds the chat archived.
        const working = await this.withTurnLock(d.chatId, async () => {
          const runner = this.runners.get(d.chatId);
          if (runner?.active) return true;
          if (runner) { this.runners.delete(d.chatId); await runner.close(); }
          this.save({ id: d.chatId, archived: true, topicId: null });
          return false;
        });
        if (working) return editMenu('Сначала останови работу.', []);
        if (chat.topicId) {
          this.state.unbindTopic(chat.topicId);
          await this.api.request('deleteForumTopic', { chat_id: this.ownerId, message_thread_id: chat.topicId }).catch(error => this.log('topic_delete_error', error));
        }
        return;
      }
    }
  }
}

const IMAGE_TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
async function imageBlock(path) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size > 3_750_000) return null;
    const bytes = await handle.readFile();
    const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpeg' : bytes.subarray(0, 4).toString('latin1') === '\x89PNG' ? 'png'
      : bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP' ? 'webp'
        : bytes.subarray(0, 3).toString('latin1') === 'GIF' ? 'gif' : null;
    return type ? { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[type], data: bytes.toString('base64') } } : null;
  } finally { await handle.close(); }
}

export function contextWindow(model = '') {
  return /\[1m\]/i.test(model) || /opus-5|sonnet-5/i.test(model) ? 1_000_000 : 200_000;
}
