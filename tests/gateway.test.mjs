import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../lib/state.mjs';
import { Gateway } from '../lib/gateway.mjs';
import { TelegramApiError } from '../lib/telegram.mjs';

const OWNER = 123456789;
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
async function settle(gateway, rounds = 6) {
  for (let i = 0; i < rounds; i++) { await tick(); await gateway.eventChain; await gateway.idle; await Promise.allSettled([...gateway.workers.values()]); }
}

class FakeApi {
  constructor() { this.calls = []; this.nextId = 100; this.nextTopic = 500; this.failTopics = new Set(); }
  record(method, params) { this.calls.push({ method, params }); }
  of(method) { return this.calls.filter(c => c.method === method).map(c => c.params); }
  gone(params) {
    if (params?.message_thread_id && this.failTopics.has(params.message_thread_id)) throw new TelegramApiError('send', 400, 'Bad Request: message thread not found');
  }
  async request(method, params = {}) {
    this.record(method, params);
    if (method === 'getMe') return { id: 987654321, has_topics_enabled: true };
    if (method === 'createForumTopic') return { message_thread_id: this.nextTopic++, name: params.name };
    return true;
  }
  async sendText(chatId, text, options = {}) { this.gone(options); this.record('sendText', { text, ...options }); return [{ message_id: this.nextId++ }]; }
  async sendAnswer(chatId, text, options = {}) { this.gone(options); this.record('sendAnswer', { text, ...options }); return [{ message_id: this.nextId++ }]; }
  async editText(chatId, messageId, text, options = {}) { this.record('editText', { messageId, text, ...options }); return true; }
  async sendDocument(chatId, path, options = {}) { this.record('sendDocument', { path, ...options }); return { message_id: this.nextId++ }; }
  stop() {}
}

class FakeRunner extends EventEmitter {
  constructor(options) { super(); Object.assign(this, options); this.alive = true; this.active = false; this.pushes = []; this.lastActivity = Date.now(); this.closed = false; }
  push(content, { priority } = {}) { this.pushes.push({ content, priority }); this.active = true; }
  async interrupt() { this.interrupted = true; }
  async close() { this.closed = true; this.alive = false; }
  async contextUsage() { return { totalTokens: 50000, maxTokens: 1000000 }; }
  async models() { return [{ value: 'opus[1m]', displayName: 'Opus · 1M', supportedEffortLevels: ['high', 'xhigh'] }]; }
  async setModel() {} async setEffort() {}
  emitMessage(message) { if (message.type === 'result') this.active = false; this.emit('message', message); }
}

class FakeDesktop {
  constructor() { this.foreignProc = null; this.terminated = []; this.paths = new Map(); }
  async pathFor(id) { return this.paths.get(id) ?? null; }
  async foreign() { return this.foreignProc; }
  async terminate(proc) { this.terminated.push(proc.pid); this.foreignProc = null; return true; }
  async live() { return this.foreignProc ? [this.foreignProc] : []; }
  async list() { return []; }
  async size() { return 0; }
  async read(path, offset) {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(path, 'utf8');
    const chunk = text.slice(offset);
    const end = chunk.lastIndexOf('\n');
    return { records: end < 0 ? [] : chunk.slice(0, end).split('\n').filter(Boolean).map(l => JSON.parse(l)), offset: offset + (end + 1) };
  }
  async info() { return { title: null }; }
  async lastAnswer() { return null; }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-tg-'));
  const api = new FakeApi();
  const state = new State(join(dir, 'state.sqlite'));
  const desktop = new FakeDesktop();
  const runners = [];
  const project = { id: 'workspace', label: 'workspace', path: '/home/user/workspace', key: 'k1' };
  const gateway = new Gateway({ api, state, desktop, ownerId: OWNER, botId: 987654321, dataDir: dir, projects: [project], home: '/home/user',
    defaults: { model: 'opus[1m]', effort: 'xhigh' }, secrets: ['SECRET-TOKEN-123'],
    runnerFactory: options => { const r = new FakeRunner(options); runners.push(r); return r; } });
  return { dir, api, state, desktop, runners, gateway, project };
}
let updateId = 1;
const message = (fields = {}) => ({ update_id: updateId++, message: { message_id: updateId + 1000, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' }, date: 1, ...fields } });
const inTopic = (topic, fields) => message({ is_topic_message: true, message_thread_id: topic, ...fields });
const press = async (gateway, button, topic) => { await gateway.receive({ update_id: updateId++, callback_query: { id: 'cb', from: { id: OWNER, is_bot: false }, data: button.callback_data,
  message: { message_id: 77, chat: { id: OWNER, type: 'private' }, ...(topic ? { is_topic_message: true, message_thread_id: topic } : {}) } } }); await gateway.idle; };
const lastButtons = api => api.calls.filter(c => c.params?.reply_markup?.inline_keyboard?.length).at(-1).params.reply_markup.inline_keyboard.flat();
const lastCard = api => api.of('editText').filter(c => c.text.startsWith('<pre>')).at(-1);
const findButton = (api, text) => api.calls.flatMap(c => c.params?.reply_markup?.inline_keyboard?.flat() ?? []).findLast(b => b.text === text);

async function startChat(ctx, text = 'Сделай отчёт') {
  ctx.gateway.lastLobby = null;
  await ctx.gateway.receive(message({ text }));
  await settle(ctx.gateway);
  const chat = ctx.state.chats().find(c => !c.archived);
  return { chat, runner: ctx.runners.at(-1) };
}

test('lobby message starts at once in workspace, with a «сменить проект» line', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  assert.equal(ctx.api.of('createForumTopic').length, 1);
  assert.equal(chat.topicId, 500);
  assert.equal(chat.cwd, '/home/user/workspace');
  assert.equal(runner.resume, false);
  assert.deepEqual(runner.pushes[0].content, [{ type: 'text', text: 'Сделай отчёт' }]);
  assert.ok(ctx.api.of('sendText').some(c => c.text === '📁 workspace' && c.reply_markup.inline_keyboard[0][0].text === 'сменить проект'));
  assert.ok(!ctx.api.of('sendText').some(c => /Новый чат в|Проект для/.test(c.text)), 'no blocking project question');
  assert.ok(ctx.api.of('setMessageReaction').some(c => c.reaction[0].emoji === '👀'));
  const card = ctx.api.of('sendText').find(c => c.text.includes('▶'));
  assert.equal(card.message_thread_id, 500);
  assert.equal(card.reply_markup.inline_keyboard[0][0].style, 'danger');
  assert.ok(ctx.api.of('editForumTopic').some(c => c.name === 'Сделай отчёт · workspace'));
});

test('a message during a running turn steers it with priority next', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  await ctx.gateway.receive(inTopic(chat.topicId, { text: 'и добавь график' }));
  await settle(ctx.gateway);
  assert.equal(runner.pushes.length, 2);
  assert.equal(runner.pushes[1].priority, 'next');
});

test('result delivers the answer into the topic and collapses the card without buttons', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  runner.emitMessage({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5[1m]' });
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'Готово: отчёт SECRET-TOKEN-123', duration_ms: 5000, uuid: 'u1' });
  await settle(ctx.gateway);
  const answer = ctx.api.of('sendAnswer')[0];
  assert.equal(answer.message_thread_id, chat.topicId);
  assert.ok(!answer.text.includes('SECRET-TOKEN-123'));
  const final = lastCard(ctx.api);
  assert.match(final.text, /✓ 0:05 · opus-5\.5 · xhigh · ctx 5%/);
  assert.deepEqual(final.reply_markup.inline_keyboard, []);
  assert.equal(ctx.state.chat(chat.id).status, 'idle');
});

test('a session that did not start on the subscription is stopped', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  runner.emitMessage({ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', model: 'x' });
  await settle(ctx.gateway);
  assert.equal(runner.closed, true);
  assert.equal(ctx.state.chat(chat.id).outcome, 'error');
});

test('a deleted topic is recreated once and the answer is resent there', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  ctx.api.failTopics.add(chat.topicId);
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'ответ', duration_ms: 1, uuid: 'u2' });
  await settle(ctx.gateway);
  assert.equal(ctx.api.of('createForumTopic').length, 2);
  assert.equal(ctx.api.of('sendAnswer').at(-1).message_thread_id, 501);
  assert.equal(ctx.state.chatForTopic(501), chat.id);
});

test('a user-created topic starts in workspace; «сменить проект» moves it and resends the first request', async () => {
  const ctx = setup();
  ctx.gateway.projects.push({ id: 'site', label: 'site', path: '/home/user/projects/site', key: 'k2' });
  await ctx.gateway.receive(inTopic(900, { forum_topic_created: { name: 'ОК', is_name_implicit: true } }));
  await ctx.gateway.receive(inTopic(900, { text: 'первая задача' }));
  await settle(ctx.gateway);
  const first = ctx.state.chat(ctx.state.chatForTopic(900));
  assert.equal(first.cwd, '/home/user/workspace');
  assert.deepEqual(ctx.runners[0].pushes[0].content, [{ type: 'text', text: 'первая задача' }]);
  assert.equal(ctx.api.of('createForumTopic').length, 0, 'the user topic is reused');
  await press(ctx.gateway, findButton(ctx.api, 'сменить проект'), 900);
  await press(ctx.gateway, findButton(ctx.api, 'site'), 900);
  await settle(ctx.gateway);
  const moved = ctx.state.chat(ctx.state.chatForTopic(900));
  assert.notEqual(moved.id, first.id);
  assert.equal(moved.cwd, '/home/user/projects/site');
  assert.equal(ctx.state.chat(first.id).archived, true);
  assert.equal(ctx.runners[0].closed, true, 'the workspace run was stopped');
  assert.deepEqual(ctx.runners[1].pushes[0].content, [{ type: 'text', text: 'первая задача' }]);
  assert.ok(ctx.api.of('editText').some(c => c.text === '📁 site'));
});

test('project move before any turn only changes the folder', async () => {
  const ctx = setup();
  ctx.gateway.projects.push({ id: 'infra', label: 'infra', path: '/home/user/infra', key: 'k3' });
  await ctx.gateway.receive(inTopic(901, { forum_topic_created: { name: 'x', is_name_implicit: true } }));
  const chatId = ctx.state.chatForTopic(901);
  await press(ctx.gateway, findButton(ctx.api, 'сменить проект'), 901);
  await press(ctx.gateway, findButton(ctx.api, 'infra'), 901);
  assert.equal(ctx.state.chatForTopic(901), chatId);
  assert.equal(ctx.state.chat(chatId).cwd, '/home/user/infra');
  assert.equal(ctx.runners.length, 0);
});

test('/stop interrupts the running turn', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  await ctx.gateway.receive(inTopic(chat.topicId, { text: '/stop' }));
  await settle(ctx.gateway);
  assert.equal(runner.interrupted, true);
  runner.emitMessage({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], duration_ms: 1000, uuid: 'u3' });
  await settle(ctx.gateway);
  assert.match(lastCard(ctx.api).text, /■ остановлено/);
});

test('strangers and group chats are ignored', async () => {
  const ctx = setup();
  await ctx.gateway.receive({ update_id: updateId++, message: { message_id: 1, from: { id: 1, is_bot: false }, chat: { id: 1, type: 'private' }, text: 'hi' } });
  await ctx.gateway.receive({ update_id: updateId++, message: { message_id: 2, from: { id: OWNER, is_bot: false }, chat: { id: -100, type: 'supergroup' }, text: 'hi' } });
  assert.equal(ctx.api.calls.length, 0);
});

test('a desktop session busy on the computer is deferred, then taken over when idle', async () => {
  const ctx = setup();
  const sessionId = 'aaaaaaaa-0000-4000-8000-000000000001';
  ctx.state.saveChat({ id: sessionId, cwd: '/home/user/workspace', project: 'workspace', title: 'Десктоп', origin: 'desktop', started: true, status: 'idle', model: 'opus[1m]', effort: 'xhigh' });
  ctx.desktop.foreignProc = { pid: 4242, sessionId, status: 'busy', procStart: '1', ours: false };
  const topic = await ctx.gateway.ensureTopic(sessionId);
  await ctx.gateway.receive(inTopic(topic, { text: 'продолжи с телефона' }));
  await settle(ctx.gateway);
  assert.equal(ctx.runners.length, 0);
  assert.ok(ctx.api.of('setMessageReaction').some(c => c.reaction[0].emoji === '✍'));
  assert.equal(ctx.state.chat(sessionId).waitDesktop, true);
  ctx.desktop.foreignProc = { pid: 4242, sessionId, status: 'idle', procStart: '1', ours: false };
  await ctx.gateway.runQueued(sessionId);
  await settle(ctx.gateway);
  assert.deepEqual(ctx.desktop.terminated, [4242]);
  assert.equal(ctx.runners[0].resume, true);
  assert.deepEqual(ctx.runners[0].pushes[0].content, [{ type: 'text', text: 'продолжи с телефона' }]);
});

test('AskUserQuestion becomes buttons and the pressed option is returned to Claude', async () => {
  const ctx = setup();
  const { chat } = await startChat(ctx);
  const pending = ctx.gateway.ask(chat.id, { questions: [{ question: 'Какой формат?', header: 'Формат', multiSelect: false, options: [{ label: 'PDF', description: 'для печати' }, { label: 'DOCX' }] }] });
  await settle(ctx.gateway);
  assert.equal(ctx.state.chat(chat.id).question, true);
  await press(ctx.gateway, findButton(ctx.api, 'DOCX'), chat.topicId);
  assert.deepEqual(await pending, { 'Какой формат?': 'DOCX' });
  assert.equal(ctx.state.chat(chat.id).question, null);
});

test('records written by the desktop app are mirrored: prompt, then final answer', async () => {
  const ctx = setup();
  const sessionId = 'aaaaaaaa-0000-4000-8000-000000000002';
  const path = join(ctx.dir, `${sessionId}.jsonl`);
  writeFileSync(path, '');
  ctx.desktop.paths.set(sessionId, path);
  ctx.state.saveChat({ id: sessionId, cwd: '/home/user/workspace', project: 'workspace', title: 'Десктоп', origin: 'desktop', started: true, status: 'idle', mirrorOffset: 0 });
  await ctx.gateway.ensureTopic(sessionId);
  appendFileSync(path, JSON.stringify({ type: 'user', entrypoint: 'claude-desktop', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Проверь лиды' } }) + '\n');
  appendFileSync(path, JSON.stringify({ type: 'assistant', entrypoint: 'claude-desktop', uuid: 'a1', timestamp: new Date().toISOString(), message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Лидов 12' }] } }) + '\n');
  appendFileSync(path, JSON.stringify({ type: 'assistant', entrypoint: 'sdk-ts', uuid: 'a2', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'моё' }] } }) + '\n');
  await ctx.gateway.pollMirrors();
  await settle(ctx.gateway);
  const prompt = ctx.api.of('sendMessage').find(c => c.text.includes('Проверь лиды'));
  assert.equal(prompt.parse_mode, 'HTML');
  assert.match(prompt.text, /^💻 <blockquote expandable>/);
  const answers = ctx.api.of('sendAnswer').map(c => c.text);
  assert.deepEqual(answers, ['Лидов 12']);
});

test('choosing a model inside a chat does not change defaults for new chats', async () => {
  const ctx = setup();
  const { chat } = await startChat(ctx);
  ctx.state.set('models', { at: Date.now(), list: [{ value: 'sonnet', displayName: 'Sonnet', efforts: ['high'] }] });
  await ctx.gateway.receive(inTopic(chat.topicId, { text: '/model' }));
  await press(ctx.gateway, lastButtons(ctx.api).find(b => b.text === 'Sonnet'), chat.topicId);
  await press(ctx.gateway, lastButtons(ctx.api).find(b => b.text === 'high'), chat.topicId);
  assert.equal(ctx.state.chat(chat.id).model, 'sonnet');
  assert.equal(ctx.state.get('defaultModel'), null);
  assert.ok(ctx.api.of('editText').some(c => c.messageId === 77));
});

test('/queue saves a separate request that runs after the current turn', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  await ctx.gateway.receive(inTopic(chat.topicId, { text: '/queue потом сделай презентацию' }));
  await settle(ctx.gateway);
  assert.equal(runner.pushes.length, 1);
  assert.equal(ctx.state.queuedTurns(chat.id).length, 1);
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'первое', duration_ms: 1, uuid: 'u5' });
  await settle(ctx.gateway, 10);
  assert.equal(runner.pushes.length, 2);
  assert.deepEqual(runner.pushes[1].content, [{ type: 'text', text: 'потом сделай презентацию' }]);
});

test('desktop mirror: one card per turn, steer adds only a quote, background and continuation are labelled', async () => {
  const ctx = setup();
  const sessionId = 'aaaaaaaa-0000-4000-8000-000000000003';
  const path = join(ctx.dir, `${sessionId}.jsonl`);
  writeFileSync(path, '');
  ctx.desktop.paths.set(sessionId, path);
  ctx.state.saveChat({ id: sessionId, cwd: '/home/user/workspace', project: 'workspace', title: 'Десктоп', origin: 'desktop', started: true, status: 'idle', mirrorOffset: 0, model: 'claude-opus-5-5', effort: 'xhigh' });
  await ctx.gateway.ensureTopic(sessionId);
  const t = new Date().toISOString();
  const write = r => appendFileSync(path, JSON.stringify({ entrypoint: 'claude-desktop', timestamp: t, ...r }) + '\n');
  write({ type: 'user', message: { role: 'user', content: 'Сделай\n\n<pasted_content id="5d52">\nдлинный текст\n</pasted_content id="5d52">' } });
  write({ type: 'assistant', uuid: 'b1', message: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'bg1', name: 'Agent', input: { description: 'ревью бота', run_in_background: true } }] } });
  write({ type: 'user', message: { role: 'user', content: 'уточнение посреди хода' } });
  write({ type: 'assistant', uuid: 'b2', message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Запустил ревью' }] } });
  await ctx.gateway.pollMirrors();
  await settle(ctx.gateway);
  const quotes = ctx.api.of('sendMessage').map(c => c.text);
  assert.equal(quotes.length, 2);
  assert.ok(!quotes[0].includes('pasted_content'));
  const cards = ctx.api.of('sendText').filter(c => c.text.includes('💻') && c.text.includes('opus'));
  assert.equal(cards.length, 1, 'steer must not open a second card');
  const collapsed = ctx.api.of('editText').at(-1);
  assert.match(collapsed.text, /💻 ✓ [^\n]*\nфон: агент «ревью бота» /);
  assert.deepEqual(collapsed.reply_markup.inline_keyboard, []);
  // Background agent finishes and wakes the session: a continuation card marked ⤷.
  appendFileSync(path, JSON.stringify({ type: 'attachment', entrypoint: 'claude-desktop', timestamp: t, attachment: { type: 'queued_command', prompt: '<task-notification>\n<tool-use-id>bg1</tool-use-id>\n<status>completed</status>\n<summary>Agent done</summary>' } }) + '\n');
  write({ type: 'assistant', uuid: 'b3', message: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } });
  await ctx.gateway.pollMirrors();
  await settle(ctx.gateway);
  const card = ctx.api.of('sendText').filter(c => c.text.includes('opus')).at(-1);
  assert.match(card.text, /💻 ⤷ .*\nпосле фоновой задачи/);
  assert.ok(!card.text.includes('фон:'), 'finished background task is gone');
  assert.equal(Object.keys(ctx.state.chat(sessionId).background).length, 0);
});

test('own runner: background task line, continuation after it, and idle close waits for background', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  runner.emitMessage({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5[1m]' });
  runner.emitMessage({ type: 'system', subtype: 'task_started', task_id: 'k1', tool_use_id: 'x1', description: 'ревью', task_type: 'local_agent', is_backgrounded: true });
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'запустил', duration_ms: 1000, uuid: 'r1' });
  await settle(ctx.gateway);
  assert.match(lastCard(ctx.api).text, /✓ [^\n]*\nфон: агент «ревью» /);
  runner.lastActivity = Date.now() - 3600000;
  await ctx.gateway.closeIdle();
  assert.equal(runner.closed, false, 'background work keeps the process');
  runner.emitMessage({ type: 'system', subtype: 'task_notification', task_id: 'k1', tool_use_id: 'x1', status: 'completed', summary: 'готово' });
  runner.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'ревью готово' }] } });
  await settle(ctx.gateway);
  assert.equal(ctx.state.chat(chat.id).trigger, 'после фоновой задачи');
  assert.match(ctx.api.of('sendText').filter(c => c.text.includes('▶')).at(-1).text, /▶ ⤷ .*\nпосле фоновой задачи/);
});

test('an album sent to the lobby becomes one chat, not one topic per photo', async () => {
  const ctx = setup();
  await ctx.gateway.receive(message({ text: 'первое', media_group_id: 'g1' }));
  await ctx.gateway.receive(message({ text: 'второе', media_group_id: 'g1' }));
  await settle(ctx.gateway, 12);
  assert.equal(ctx.api.of('createForumTopic').length, 1);
  assert.equal(ctx.state.chats().length, 1);
});

test('a background workflow shows its name and agent progress, live after the turn, frozen when it ends', async () => {
  const ctx = setup();
  const sessionId = 'aaaaaaaa-0000-4000-8000-000000000009';
  const path = join(ctx.dir, `${sessionId}.jsonl`);
  const wfDir = join(ctx.dir, 'wf');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(wfDir);
  writeFileSync(path, '');
  ctx.desktop.paths.set(sessionId, path);
  ctx.state.saveChat({ id: sessionId, cwd: '/home/user/workspace', project: 'workspace', title: 'Десктоп', origin: 'desktop', started: true, status: 'idle', mirrorOffset: 0, model: 'claude-opus-5-5', effort: 'xhigh' });
  await ctx.gateway.ensureTopic(sessionId);
  ctx.desktop.foreignProc = { pid: 4343, sessionId, status: 'idle', procStart: '1', ours: false }; // the app process runs the workflow
  const t = new Date().toISOString();
  const write = r => appendFileSync(path, JSON.stringify({ entrypoint: 'claude-desktop', timestamp: t, ...r }) + '\n');
  write({ type: 'user', message: { role: 'user', content: 'сверь документацию' } });
  write({ type: 'assistant', uuid: 'w1', message: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'wf1', name: 'Workflow', input: { script: "export const meta = {\n  name: 'bots-docs-audit',\n  description: 'x' }" } }] } });
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wf1', content: `Workflow launched in background.\nTranscript dir: /home/user/.claude/projects/x/wf\n` }] } });
  write({ type: 'assistant', uuid: 'w2', message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Запустил сверку' }] } });
  await ctx.gateway.pollMirrors();
  await settle(ctx.gateway);
  // Point the recorded dir at the fixture (the real path is validated to live under ~/.claude/projects).
  const chat = ctx.state.chat(sessionId);
  ctx.state.saveChat({ id: sessionId, background: { wf1: { ...chat.background.wf1, dir: wfDir } } });
  writeFileSync(join(wfDir, 'agent-a.meta.json'), '{}');
  writeFileSync(join(wfDir, 'agent-b.meta.json'), '{}');
  writeFileSync(join(wfDir, 'journal.jsonl'), '{"type":"result","agent":"a"}\n');
  await ctx.gateway.refreshCards();
  const live = lastCard(ctx.api);
  assert.match(live.text, /✓ [^\n]*\nфон: workflow «bots-docs-audit» \d+:\d\d · агенты 1\/2/);
  assert.deepEqual(live.reply_markup.inline_keyboard, []);
  assert.equal(chat.background.wf1.dir, '/home/user/.claude/projects/x/wf');
  // Workflow finishes: the notification removes it and the card freezes to one line.
  appendFileSync(path, JSON.stringify({ type: 'attachment', entrypoint: 'claude-desktop', timestamp: t, attachment: { type: 'queued_command', prompt: '<task-notification>\n<tool-use-id>wf1</tool-use-id>\n<status>completed</status>' } }) + '\n');
  await ctx.gateway.pollMirrors();
  await ctx.gateway.refreshCards();
  const frozen = lastCard(ctx.api);
  assert.match(frozen.text, /^<pre>💻 ✓ [^<\n]*<\/pre>/);
  assert.equal(ctx.state.chat(sessionId).bgCardId, null);
});

test('restart: a queued request cut mid-dispatch pauses the queue and is reported in its topic', async () => {
  const ctx = setup();
  const { chat } = await startChat(ctx);
  const item = ctx.state.queueTurn(chat.id, { messageId: 5, input: [{ type: 'text', text: 'x' }], preview: 'сделай презентацию' });
  ctx.state.queueStatus(item.id, 'dispatching');
  await ctx.gateway.start();
  await ctx.gateway.close();
  assert.equal(ctx.state.chat(chat.id).queuePaused, true);
  assert.ok(ctx.api.of('sendText').some(c => c.message_thread_id === chat.topicId && c.text.includes('«сделай презентацию» мог не уйти')));
});

test('moving a chat to another project cancels requests queued for the old chat', async () => {
  const ctx = setup();
  ctx.gateway.projects.push({ id: 'infra', label: 'infra', path: '/home/user/infra', key: 'k3' });
  const { chat, runner } = await startChat(ctx);
  await ctx.gateway.receive(inTopic(chat.topicId, { text: '/queue потом' }));
  await settle(ctx.gateway);
  assert.equal(ctx.state.queuedTurns(chat.id).length, 1);
  runner.emitMessage({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5' });
  await settle(ctx.gateway);
  await press(ctx.gateway, findButton(ctx.api, 'сменить проект'), chat.topicId);
  await press(ctx.gateway, findButton(ctx.api, 'infra'), chat.topicId);
  await settle(ctx.gateway);
  assert.equal(ctx.state.queuedTurns(chat.id).length, 0);
});

test('the card shows what the agent says along the way and drops it once the turn is over', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  runner.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Сначала прогоню тесты,\nпотом поправлю.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } });
  await settle(ctx.gateway);
  await ctx.gateway.refreshCard(chat.id);
  assert.ok(lastCard(ctx.api).text.endsWith('</pre>\nСначала прогоню тесты,\nпотом поправлю.'), lastCard(ctx.api).text);
  runner.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '**Тесты** прошли.' }, { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/x/a.mjs' } }] } });
  await settle(ctx.gateway);
  await ctx.gateway.refreshCard(chat.id);
  assert.ok(lastCard(ctx.api).text.endsWith('</pre>\nСначала прогоню тесты,\nпотом поправлю.\n\n<b>Тесты</b> прошли.'), lastCard(ctx.api).text);
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'Готово', duration_ms: 1000, uuid: 'u-note' });
  await settle(ctx.gateway);
  assert.match(lastCard(ctx.api).text, /^<pre>✓ [^<]*<\/pre>\n<blockquote expandable>Сначала прогоню тесты,\nпотом поправлю\.\n\n<b>Тесты<\/b> прошли\.<\/blockquote>$/, 'the history is not kept under the final line');
});

test('«Новый чат» in Telegram (a topic plus /new) is one chat in that topic, not a second topic', async () => {
  const ctx = setup();
  await ctx.gateway.receive(inTopic(950, { forum_topic_created: { name: '/new', is_name_implicit: true } }));
  await ctx.gateway.receive(inTopic(950, { text: '/new' }));
  await settle(ctx.gateway);
  assert.equal(ctx.api.of('createForumTopic').length, 0, 'a second topic appeared');
  assert.equal(ctx.state.chats().length, 1);
  assert.ok(ctx.api.of('editForumTopic').some(c => c.message_thread_id === 950 && c.name === 'Новый чат · workspace'));
  await ctx.gateway.receive(inTopic(950, { text: 'Подключись к рекламному кабинету и сними статистику по Москве за неделю' }));
  await settle(ctx.gateway);
  assert.ok(ctx.api.of('editForumTopic').some(c => c.name === 'Подключись к рекламному кабинету и сними… · workspace'));
});

test('after the first successful turn a bot chat gets a short title, once', async () => {
  const ctx = setup();
  const asked = [];
  ctx.gateway.titler = async text => { asked.push(text); return 'Статистика Москвы за неделю'; };
  const { chat, runner } = await startChat(ctx, 'Ты можешь пожалуйста подключиться к рекламному кабинету и собрать статистику по Москве за неделю');
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'Лидов 124', duration_ms: 1000, uuid: 'u-t1' });
  await settle(ctx.gateway);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Запрос: Ты можешь пожалуйста подключиться[\s\S]*Начало ответа: Лидов 124$/);
  assert.equal(ctx.state.chat(chat.id).title, 'Статистика Москвы за неделю');
  assert.ok(ctx.api.of('editForumTopic').some(c => c.name === 'Статистика Москвы за неделю · workspace'));
  await ctx.gateway.receive(inTopic(chat.topicId, { text: 'а за прошлую?' }));
  await settle(ctx.gateway);
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'Лидов 98', duration_ms: 1000, uuid: 'u-t2' });
  await settle(ctx.gateway);
  assert.equal(asked.length, 1, 'titled again');
});

test('chatTitle cleans the model output and runs only on the subscription', async () => {
  const { chatTitle } = await import('../lib/claude.mjs');
  const run = (apiKeySource, result) => chatTitle('запрос', { env: {}, queryImpl: () => (async function* () {
    yield { type: 'system', subtype: 'init', apiKeySource };
    yield { type: 'result', subtype: 'success', result };
  })() });
  assert.equal(await run('none', '«Статистика Москвы за неделю».\nлишнее'), 'Статистика Москвы за неделю');
  assert.equal(await run('ANTHROPIC_API_KEY', 'Название'), null);
});

test('startup: a welcome once; without Threaded Mode a hint to switch it on in the BotFather mini app', async () => {
  const ctx = setup();
  await ctx.gateway.start();
  await ctx.gateway.close();
  assert.equal(ctx.api.of('sendText').filter(c => /Claude на связи/.test(c.text)).length, 1);
  const off = setup();
  const request = off.api.request.bind(off.api);
  off.api.request = async (method, params) => method === 'getMe' ? { id: 987654321, has_topics_enabled: false } : request(method, params);
  await off.gateway.start();
  await off.gateway.close();
  const help = off.api.of('sendText').find(c => /Threaded Mode/.test(c.text));
  assert.match(help.text, /Open.*My bots.*Bot Settings.*Threads Settings/);
  const other = setup();
  other.gateway.botId = 555;
  await assert.rejects(other.gateway.start(), /another bot/);
});

test('a session outside the home folder or in a dot-folder gets no auto topic', () => {
  const ctx = setup();
  assert.equal(ctx.gateway.inHome('/home/user/projects/site'), true);
  assert.equal(ctx.gateway.inHome('/home/user'), true);
  assert.equal(ctx.gateway.inHome('/home/user/.claude/x'), false);
  assert.equal(ctx.gateway.inHome('/home/username/x'), false);
  assert.equal(ctx.gateway.inHome('/tmp/x'), false);
});

test('with the cloud Bot API a file over 50 MB is not uploaded; the chat learns where it lies', async () => {
  const ctx = setup();
  const { chat } = await startChat(ctx);
  const big = join(ctx.dir, 'video.mov');
  writeFileSync(big, '');
  (await import('node:fs')).truncateSync(big, 51 * 1024 * 1024);
  await ctx.gateway.sendArtifacts(chat.id, `[video](${big})`, 'big-1');
  await ctx.gateway.sendArtifacts(chat.id, `[video](${big})`, 'big-1');
  assert.equal(ctx.api.of('sendDocument').length, 0);
  assert.equal(ctx.api.of('sendText').filter(c => /больше 50 МБ/.test(c.text) && /video\.mov/.test(c.text)).length, 1);
});

test('copies of sent files older than 14 days are deleted with their /files entries; fresh ones and received files stay', async () => {
  const { dir, state, gateway } = setup();
  const out = join(dir, 'files', 'chat-1', 'outputs');
  mkdirSync(out, { recursive: true });
  const old = join(out, 'a__old.mp4'), fresh = join(out, 'b__fresh.png'), received = join(dir, 'files', 'chat-1', 'voice.ogg');
  for (const path of [old, fresh, received]) writeFileSync(path, 'x');
  const past = (Date.now() - 15 * 86400000) / 1000;
  utimesSync(old, past, past); utimesSync(received, past, past);
  const oldFile = state.addFile('chat-1', { path: old, name: 'old.mp4', size: 1, direction: 'out' });
  const freshFile = state.addFile('chat-1', { path: fresh, name: 'fresh.png', size: 1, direction: 'out' });
  state.set('artifact:answer:s:u:file:/x/old.mp4', oldFile.id);
  await gateway.pruneOutputs();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(received), true);
  assert.deepEqual(state.files('chat-1').map(f => f.id), [freshFile.id]);
  assert.equal(state.get('artifact:answer:s:u:file:/x/old.mp4'), null);
  state.close();
});
test('/model lists the newest Opus, Fable, Sonnet and Haiku with versions; ultracode follows max', async () => {
  const ctx = setup();
  const { chat } = await startChat(ctx);
  const all = ['low', 'medium', 'high', 'xhigh', 'max'];
  ctx.state.set('models', { at: Date.now(), list: [
    { value: 'default', resolved: 'claude-opus-5-5', displayName: 'Default', efforts: all },
    { value: 'opus[1m]', resolved: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', efforts: all },
    { value: 'claude-fable-5-1[1m]', resolved: 'claude-fable-5-1[1m]', displayName: 'Fable', efforts: all },
    { value: 'sonnet', resolved: 'claude-sonnet-5-5', displayName: 'Sonnet', efforts: all },
    { value: 'haiku', resolved: 'claude-haiku-4-5-20251001', displayName: 'Haiku', efforts: [] },
    { value: 'claude-sonnet-5', resolved: 'claude-sonnet-5', displayName: 'Sonnet 5', efforts: all },
    { value: 'claude-opus-4-8', resolved: 'claude-opus-4-8', displayName: 'Opus 4.8', efforts: all },
  ] });
  await ctx.gateway.receive(inTopic(chat.topicId, { text: '/model' }));
  assert.deepEqual(lastButtons(ctx.api).map(b => b.text), ['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 4.5']);
  await press(ctx.gateway, lastButtons(ctx.api).find(b => b.text === 'Sonnet 5.5'), chat.topicId);
  assert.deepEqual(lastButtons(ctx.api).map(b => b.text), [...all, 'ultracode']);
  await press(ctx.gateway, lastButtons(ctx.api).find(b => b.text === 'ultracode'), chat.topicId);
  assert.equal(ctx.state.chat(chat.id).model, 'sonnet');
  assert.equal(ctx.state.chat(chat.id).effort, 'ultracode');
});

test('ultracode starts the session at xhigh with the ultracode setting; another level switches it off', async () => {
  const { ClaudeRunner } = await import('../lib/claude.mjs');
  let options;
  const runner = new ClaudeRunner({ id: 'u', cwd: '/tmp', effort: 'ultracode', env: {}, queryImpl: args => { options = args.options; return { applyFlagSettings: async s => { runner.applied = s; }, async *[Symbol.asyncIterator]() {} }; } }).start();
  assert.equal(options.effort, 'xhigh');
  assert.deepEqual(options.settings, { ultracode: true });
  runner.alive = true;
  await runner.setEffort('high');
  assert.deepEqual(runner.applied, { effortLevel: 'high', ultracode: null });
});

