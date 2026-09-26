// Fakes for the adversarial review; modelled on tests/gateway.test.mjs, plus hooks for
// blocking/failing Telegram calls and a runner that behaves like ClaudeRunner on close.
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
export const { State } = await import(`${ROOT}/lib/state.mjs`);
export const { Gateway } = await import(`${ROOT}/lib/gateway.mjs`);
export const { TelegramApiError } = await import(`${ROOT}/lib/telegram.mjs`);
export const { ClaudeRunner } = await import(`${ROOT}/lib/claude.mjs`);
export const { Desktop } = await import(`${ROOT}/lib/desktop.mjs`);

export const OWNER = 123456789;
export const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
// Like settle() in the project tests, but never awaits eventChain (it may be blocked on purpose).
export async function spin(gateway, rounds = 8) {
  for (let i = 0; i < rounds; i++) { await tick(); await Promise.race([Promise.allSettled([...gateway.workers.values(), ...gateway.tasks]), tick(50)]); }
}
export async function settle(gateway, rounds = 6) {
  for (let i = 0; i < rounds; i++) { await tick(); await gateway.eventChain; await gateway.idle; await Promise.allSettled([...gateway.workers.values()]); }
}

export class FakeApi {
  constructor() {
    this.calls = []; this.nextId = 100; this.nextTopic = 500; this.failTopics = new Set();
    this.stopped = false; this.gates = []; this.failOnce = [];
  }
  record(method, params) { this.calls.push({ method, params }); }
  of(method) { return this.calls.filter(c => c.method === method).map(c => c.params); }
  async guard(method, params) {
    if (this.stopped) throw new DOMException('Telegram request cancelled', 'AbortError');
    const fail = this.failOnce.findIndex(f => f.method === method && f.test(params));
    if (fail >= 0) { this.failOnce.splice(fail, 1); throw new TelegramApiError(method, 0, 'network or invalid response'); }
    const gate = this.gates.find(g => g.method === method && g.test(params) && !g.used);
    if (gate) { gate.used = true; gate.entered = true; await gate.promise; }
    if (params?.message_thread_id && this.failTopics.has(params.message_thread_id)) throw new TelegramApiError(method, 400, 'Bad Request: message thread not found');
  }
  // Block the next matching call until gate.open() is called.
  gate(method, test = () => true) {
    const g = { method, test }; g.promise = new Promise(resolve => { g.open = resolve; }); this.gates.push(g); return g;
  }
  async request(method, params = {}) {
    await this.guard(method, params);
    this.record(method, params);
    if (method === 'getMe') return { id: 987654321, has_topics_enabled: true };
    if (method === 'createForumTopic') return { message_thread_id: this.nextTopic++, name: params.name };
    return true;
  }
  async sendText(chatId, text, options = {}) { await this.guard('sendText', { text, ...options }); this.record('sendText', { text, ...options }); return [{ message_id: this.nextId++ }]; }
  async sendAnswer(chatId, text, options = {}) { await this.guard('sendAnswer', { text, ...options }); this.record('sendAnswer', { text, ...options }); return [{ message_id: this.nextId++ }]; }
  async editText(chatId, messageId, text, options = {}) { await this.guard('editText', { messageId, text, ...options }); this.record('editText', { messageId, text, ...options }); return true; }
  async sendDocument(chatId, path, options = {}) { await this.guard('sendDocument', options); this.record('sendDocument', { path, ...options }); return { message_id: this.nextId++ }; }
  async download(fileId, destination, { signal } = {}) {
    this.record('download', { fileId });
    await new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Telegram download cancelled', 'AbortError')), { once: true }));
  }
  stop() { this.stopped = true; }
}

// Behaves like ClaudeRunner where it matters: close() emits 'exit', push() after close throws.
export class FakeRunner extends EventEmitter {
  constructor(options) { super(); Object.assign(this, options); this.alive = true; this.active = false; this.pushes = []; this.lastActivity = Date.now(); this.closed = false; this.closeGate = null; }
  push(content, { priority } = {}) {
    if (!this.alive || this.closed) throw new Error('Claude session is not running.');
    this.pushes.push({ content, priority }); this.active = true;
  }
  async interrupt() { this.interrupted = true; }
  async close() {
    if (this.closed) return; this.closed = true;
    if (this.closeGate) await this.closeGate;
    this.alive = false; this.active = false; this.emit('exit', null);
  }
  async contextUsage() { return { totalTokens: 50000, maxTokens: 1000000 }; }
  async models() { return [{ value: 'opus[1m]', displayName: 'Opus · 1M', supportedEffortLevels: ['high', 'xhigh'] }]; }
  async setModel() {} async setEffort() {}
  emitMessage(message) { if (message.type === 'result' && !(message.queued_turn_count > 0)) this.active = false; this.emit('message', message); }
}

export class FakeDesktop {
  constructor() { this.foreignProc = null; this.terminated = []; this.paths = new Map(); }
  async pathFor(id) { return this.paths.get(id) ?? null; }
  async foreign(id) { return this.foreignProc && this.foreignProc.sessionId === id ? this.foreignProc : null; }
  async terminate(proc) { this.terminated.push(proc.pid); this.foreignProc = null; return true; }
  async live() { return this.foreignProc ? [this.foreignProc] : []; }
  async list() { return []; }
  async size(path) { return statSync(path).size; }
  async read(path, offset) {
    const text = readFileSync(path, 'utf8');
    const chunk = text.slice(offset);
    const end = chunk.lastIndexOf('\n');
    return { records: end < 0 ? [] : chunk.slice(0, end).split('\n').filter(Boolean).map(l => JSON.parse(l)), offset: offset + (end + 1) };
  }
  async info() { return { title: null }; }
  async lastAnswer() { return null; }
}

export function setup({ state, desktop, api, runnerFactory } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-tg-review-'));
  api ??= new FakeApi();
  state ??= new State(join(dir, 'state.sqlite'));
  desktop ??= new FakeDesktop();
  const runners = [];
  const project = { id: 'workspace', label: 'workspace', path: '/home/user/workspace', key: 'k1' };
  const gateway = new Gateway({ api, state, desktop, ownerId: OWNER, botId: 987654321, dataDir: dir, projects: [project], home: '/home/user',
    defaults: { model: 'opus[1m]', effort: 'xhigh' }, secrets: ['SECRET-TOKEN-123'],
    runnerFactory: runnerFactory ?? (options => { const r = new FakeRunner(options); runners.push(r); return r; }) });
  return { dir, api, state, desktop, runners, gateway, project };
}

let updateId = 1;
export const nextUpdateId = () => updateId++;
export const message = (fields = {}) => ({ update_id: updateId++, message: { message_id: updateId + 1000, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' }, date: 1, ...fields } });
export const inTopic = (topic, fields) => message({ is_topic_message: true, message_thread_id: topic, ...fields });
export const press = async (gateway, button, topic) => { await gateway.receive({ update_id: updateId++, callback_query: { id: 'cb', from: { id: OWNER, is_bot: false }, data: button.callback_data,
  message: { message_id: 77, chat: { id: OWNER, type: 'private' }, ...(topic ? { is_topic_message: true, message_thread_id: topic } : {}) } } }); await gateway.idle; };
export const lastButtons = api => api.calls.filter(c => c.params?.reply_markup?.inline_keyboard?.length).at(-1).params.reply_markup.inline_keyboard.flat();

export async function startChat(ctx, text = 'Сделай отчёт') {
  const before = new Set(ctx.state.chats().map(c => c.id));
  ctx.gateway.lastLobby = null; // each helper call is a separate conversation, not a burst
  await ctx.gateway.receive(message({ text }));
  await spin(ctx.gateway);
  const chat = ctx.state.chats().find(c => !before.has(c.id));
  return { chat, runner: ctx.runners.find(r => r.id === chat.id) };
}

// Controllable stand-in for the SDK query() used by the real ClaudeRunner.
export function fakeQuery() {
  const out = { prompts: [], queue: [], waiting: null, interrupted: false };
  out.queryImpl = ({ prompt }) => {
    void (async () => { for await (const m of prompt) out.prompts.push(m); })();
    return {
      [Symbol.asyncIterator]() { return this; },
      next() { return out.queue.length ? Promise.resolve({ value: out.queue.shift(), done: false }) : new Promise(r => { out.waiting = r; }); },
      return() { return Promise.resolve({ value: undefined, done: true }); },
      interrupt: async () => { out.interrupted = true; },
      getContextUsage: async () => ({ totalTokens: 1000, maxTokens: 1000000 }),
      supportedModels: async () => [],
    };
  };
  out.emit = m => { if (out.waiting) { const w = out.waiting; out.waiting = null; w({ value: m, done: false }); } else out.queue.push(m); };
  return out;
}
