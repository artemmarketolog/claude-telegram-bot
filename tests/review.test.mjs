// Regression tests from the adversarial review (2026-09-24): each reproduced a defect before the fix.
// reviewed code (snapshot 2026-09-24 19:40) each one fails and thereby reproduces its finding.
// Review regression tests.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ClaudeRunner, Desktop, FakeApi, FakeRunner, OWNER, State, inTopic, message, nextUpdateId, press,
  settle, setup, spin, startChat, tick, fakeQuery,
} from './review-fakes.mjs';

const rec = (fields) => JSON.stringify({ timestamp: new Date().toISOString(), ...fields }) + '\n';

test('H1 finishTurn must not collapse a turn that started while the answer was being delivered', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  runner.emitMessage({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5' });
  await settle(ctx.gateway);
  const gate = ctx.api.gate('sendAnswer');
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'Первый ответ', duration_ms: 1000, uuid: 'r1' });
  await spin(ctx.gateway, 3);
  assert.ok(gate.entered, 'answer delivery is in flight');
  // The owner replies as soon as the first part of the answer shows up.
  await ctx.gateway.receive(inTopic(chat.topicId, { text: 'а теперь график' }));
  await spin(ctx.gateway);
  // Chosen design: the next turn starts right after the previous answer is delivered (turn lock).
  gate.open();
  await settle(ctx.gateway);
  assert.equal(runner.pushes.length, 2, 'second turn was pushed');
  const secondCard = ctx.state.chat(chat.id).statusMessageId;
  assert.equal(ctx.state.chat(chat.id).status, 'active');
  // The second turn produces its first message.
  runner.emitMessage({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'начинаю' }] } });
  await settle(ctx.gateway);
  const collapsed = ctx.api.of('editText').filter(c => c.messageId === secondCard && /✓/.test(c.text));
  assert.deepEqual(collapsed, [], 'card of the running second turn was collapsed to ✓ by the first turn');
  assert.equal(ctx.state.chat(chat.id).trigger ?? null, null, 'owner message mislabelled as "после фоновой задачи"');
});

test('H1b one chat delivering a slow answer must not stall Claude events of another chat', async () => {
  const ctx = setup();
  const a = await startChat(ctx, 'чат А');
  const b = await startChat(ctx, 'чат Б');
  const gate = ctx.api.gate('sendAnswer', p => p.text === 'ответ А');
  a.runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'ответ А', duration_ms: 1, uuid: 'ra' });
  await spin(ctx.gateway, 3);
  b.runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'ответ Б', duration_ms: 1, uuid: 'rb' });
  await spin(ctx.gateway, 10);
  const delivered = ctx.api.of('sendAnswer').map(c => c.text);
  gate.open();
  await settle(ctx.gateway);
  assert.ok(delivered.includes('ответ Б'), 'chat B answer waited for chat A upload (global eventChain)');
});

test('H2 graceful restart mid-turn: answer already in the transcript is delivered after start', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  runner.emitMessage({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5' });
  await settle(ctx.gateway);
  const path = join(ctx.dir, `${chat.id}.jsonl`);
  writeFileSync(path, rec({ type: 'assistant', uuid: 'fin', entrypoint: 'sdk-ts', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Готовый ответ' }] } }));
  ctx.desktop.paths.set(chat.id, path);
  await ctx.gateway.close();                     // systemctl restart → SIGTERM → shutdown()
  const api2 = new FakeApi();
  const second = setup({ state: ctx.state, desktop: ctx.desktop, api: api2 });
  await second.gateway.start();
  await settle(second.gateway);
  await second.gateway.close();
  assert.ok(api2.of('sendAnswer').some(c => c.text === 'Готовый ответ'), 'recoverTurn skipped: onExit saved status idle during shutdown');
});

test('H2b attachment downloading during shutdown is not silently marked done', async () => {
  const ctx = setup();
  const { chat } = await startChat(ctx);
  ctx.runners[0].emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1, uuid: 'r0' });
  await settle(ctx.gateway);
  const update = inTopic(chat.topicId, { document: { file_id: 'F1', file_unique_id: 'U1', file_name: 'big.zip', file_size: 10 } });
  await ctx.gateway.receive(update);
  await spin(ctx.gateway, 5);
  assert.ok(ctx.api.of('download').length, 'download started');
  await ctx.gateway.close();
  const row = ctx.state.db.prepare('SELECT status FROM updates WHERE id=?').get(update.update_id);
  assert.notEqual(row.status, 'done', 'the file was never delivered to Claude but the update is closed as done');
});

test('M1 steer that lands right at the turn boundary keeps the runner active (so /stop works)', async () => {
  const fq = fakeQuery();
  const ctx = setup({ runnerFactory: options => new ClaudeRunner({ ...options, env: {}, queryImpl: fq.queryImpl }).start() });
  const { chat } = await startChat(ctx);
  fq.emit({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5', session_id: chat.id });
  await settle(ctx.gateway);
  await ctx.gateway.receive(inTopic(chat.topicId, { text: 'и ещё добавь график' }));   // pushed with priority next
  await settle(ctx.gateway);
  // The CLI had already finished turn 1 before it read the steer: queued_turn_count is 0,
  // then it starts a new turn for the steer.
  fq.emit({ type: 'result', subtype: 'success', is_error: false, result: 'готово', duration_ms: 1, uuid: 'x1', queued_turn_count: 0 });
  await settle(ctx.gateway);
  fq.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'sleep 600' } }] } });
  await settle(ctx.gateway);
  await ctx.gateway.receive(inTopic(chat.topicId, { text: '/stop' }));
  await settle(ctx.gateway);
  assert.equal(fq.interrupted, true, 'runner.active was reset by the previous result, /stop did nothing');
});

test('M2 a deferred "after the computer" message is sent even if the queue was paused by an earlier error', async () => {
  const ctx = setup();
  const id = randomUUID();
  const path = join(ctx.dir, `${id}.jsonl`);
  writeFileSync(path, '');
  ctx.desktop.paths.set(id, path);
  ctx.state.saveChat({ id, cwd: '/home/user/workspace', project: 'workspace', title: 'Десктоп', origin: 'desktop', started: true,
    status: 'idle', outcome: 'error', queuePaused: true, mirrorOffset: 0, model: 'opus[1m]', effort: 'xhigh' });
  const topic = await ctx.gateway.ensureTopic(id);
  ctx.desktop.foreignProc = { pid: 4242, sessionId: id, status: 'busy', procStart: '1', ours: false };
  await ctx.gateway.receive(inTopic(topic, { text: 'продолжи с телефона' }));
  await settle(ctx.gateway);
  assert.equal(ctx.state.chat(id).waitDesktop, true);
  ctx.desktop.foreignProc = { pid: 4242, sessionId: id, status: 'idle', procStart: '1', ours: false };
  await ctx.gateway.pollMirrors();
  await settle(ctx.gateway);
  assert.equal(ctx.runners.length, 1, 'message with ✍ stays in turn_queue forever because queuePaused=true');
});

test('M3 an idle desktop process of the same session must not kill the bot turn that is running', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  runner.emitMessage({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5' });
  await settle(ctx.gateway);
  // The owner opened the session in the Mac app: an idle ccd-cli for the same session appears.
  ctx.desktop.foreignProc = { pid: 777, sessionId: chat.id, status: 'idle', procStart: '1', ours: false };
  await ctx.gateway.receive(inTopic(chat.topicId, { text: 'уточнение' }));
  await settle(ctx.gateway);
  assert.equal(runner.closed, false, 'running bot turn was closed mid-work');
  assert.equal(runner.pushes.at(-1).priority, 'next');
});

test('M4 desktop process in status "shell" is treated as busy (never SIGTERM a running shell)', async () => {
  const ctx = setup();
  const id = randomUUID();
  ctx.state.saveChat({ id, cwd: '/home/user/workspace', project: 'workspace', title: 'Десктоп', origin: 'desktop', started: true, status: 'idle', model: 'opus[1m]', effort: 'xhigh' });
  const topic = await ctx.gateway.ensureTopic(id);
  ctx.desktop.foreignProc = { pid: 4343, sessionId: id, status: 'shell', procStart: '1', ours: false };
  await ctx.gateway.receive(inTopic(topic, { text: 'продолжи' }));
  await settle(ctx.gateway);
  assert.deepEqual(ctx.desktop.terminated, [], 'CLI statuses are busy|shell|idle|waiting; shell was terminated');
});

test('M5 restart recovery finds the answer in a transcript larger than 8 MB', async () => {
  const ctx = setup();
  const root = join(ctx.dir, 'claude');
  const sid = randomUUID();
  mkdirSync(join(root, 'projects', '-home-user-workspace'), { recursive: true });
  const path = join(root, 'projects', '-home-user-workspace', `${sid}.jsonl`);
  const old = JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'x'.repeat(4000) } }) + '\n';
  writeFileSync(path, old.repeat(Math.ceil(9 * 1024 * 1024 / old.length)));
  appendFileSync(path, rec({ type: 'assistant', uuid: 'late', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ответ после рестарта' }] } }));
  ctx.gateway.desktop = new Desktop({ root });
  const answer = await ctx.gateway.transcriptAnswerSince(sid, Date.now() - 60000);
  assert.equal(answer?.text, 'ответ после рестарта', 'read(path, 0) returns only the first 8 MB');
});

test('M6 lobby message survives a failed topic creation without stopping the bot', async () => {
  const ctx = setup();
  const update = message({ text: 'важная задача' });
  ctx.api.failOnce.push({ method: 'createForumTopic', test: () => true });
  await ctx.gateway.receive(update);                   // polling (and every other chat) goes on; the message stays held
  assert.equal(ctx.runners.length, 0);
  await ctx.gateway.retryHeld();                       // the one-minute timer
  await spin(ctx.gateway);
  assert.ok(ctx.runners.some(r => r.pushes?.some(p => JSON.stringify(p.content).includes('важная задача'))), 'message is held forever');
  await ctx.gateway.receive(update);                   // a redelivered update is not started twice
  await ctx.gateway.retryHeld();
  await spin(ctx.gateway);
  assert.equal(ctx.api.of('createForumTopic').length, 1);
});

test('M7 failed question send must not turn every later message into an answer to a dead question', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  ctx.api.failOnce.push({ method: 'sendText', test: p => p.text.startsWith('❓') });
  // Chosen design: a question that cannot be shown is denied (null), not thrown.
  assert.equal(await ctx.gateway.ask(chat.id, { questions: [{ question: 'Какой формат?', multiSelect: false, options: [{ label: 'PDF' }, { label: 'DOCX' }] }] }), null);
  await ctx.gateway.receive(inTopic(chat.topicId, { text: 'сделай в PDF и продолжай' }));
  await settle(ctx.gateway);
  assert.equal(runner.pushes.length, 2, 'text was swallowed by answerFree for a question nobody awaits');
  assert.equal(ctx.gateway.questions.size, 0, 'question entry leaked (also blocks closeIdle forever)');
});

test('M8 opening a session whose topic the owner deleted recreates the topic', async () => {
  const ctx = setup();
  const id = randomUUID();
  ctx.state.saveChat({ id, cwd: '/home/user/workspace', project: 'workspace', title: 'Сессия', origin: 'desktop', started: true, status: 'idle', model: 'opus[1m]', effort: 'xhigh' });
  const topic = await ctx.gateway.ensureTopic(id);
  ctx.api.failTopics.add(topic);                        // owner deleted the topic in Telegram
  const before = ctx.api.calls.length;
  await press(ctx.gateway, ctx.gateway.button('x', 'open', { sessionId: id }));
  const after = ctx.api.calls.slice(before).map(c => c.method);
  assert.ok(after.includes('createForumTopic'), `nothing visible happened: ${after.join(',')}`);
});

test('M9 taking over an idle desktop session first mirrors its not-yet-polled final answer', async () => {
  const ctx = setup();
  const id = randomUUID();
  const path = join(ctx.dir, `${id}.jsonl`);
  writeFileSync(path, '');
  ctx.desktop.paths.set(id, path);
  ctx.state.saveChat({ id, cwd: '/home/user/workspace', project: 'workspace', title: 'Десктоп', origin: 'desktop', started: true, status: 'idle', mirrorOffset: 0, model: 'opus[1m]', effort: 'xhigh' });
  const topic = await ctx.gateway.ensureTopic(id);
  // Desktop finished a turn 2 s ago; the 5-second mirror poll has not run yet.
  appendFileSync(path, rec({ type: 'user', entrypoint: 'claude-desktop', message: { role: 'user', content: 'Посчитай лиды' } }));
  appendFileSync(path, rec({ type: 'assistant', entrypoint: 'claude-desktop', uuid: 'd1', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Лидов 12' }] } }));
  ctx.desktop.foreignProc = { pid: 4444, sessionId: id, status: 'idle', procStart: '1', ours: false };
  await ctx.gateway.receive(inTopic(topic, { text: 'а за вчера?' }));
  await settle(ctx.gateway);
  await ctx.gateway.pollMirrors();
  assert.ok(ctx.api.of('sendAnswer').some(c => c.text === 'Лидов 12'), 'mirrorOffset jumped to file size: desktop answer skipped');
});

test('L1 mirror makes progress past a single transcript line longer than 8 MB', async () => {
  const dir = setup().dir;
  const path = join(dir, 'big.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'user', message: { content: 'y'.repeat(9 * 1024 * 1024) } }) + '\n' + rec({ type: 'assistant', uuid: 'after' }));
  const { records, offset } = await new Desktop({ root: dir }).read(path, 0);
  assert.ok(offset > 0 || records.length, 'offset stays 0: mirror re-reads 8 MB every 5 s and never advances');
});

test('L2 concurrent dispatch never gets a runner that the mirror is closing', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  runner.emitMessage({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5' });
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1, uuid: 'r1' });
  await settle(ctx.gateway);
  const path = join(ctx.dir, `${chat.id}.jsonl`);
  writeFileSync(path, '');
  ctx.desktop.paths.set(chat.id, path);
  ctx.state.saveChat({ id: chat.id, mirrorOffset: 0 });
  appendFileSync(path, rec({ type: 'user', entrypoint: 'claude-desktop', message: { role: 'user', content: 'с компьютера' } }));
  let release; runner.closeGate = new Promise(r => { release = r; });
  const mirroring = ctx.gateway.pollMirrors();          // closes the idle runner (slow CLI exit)
  await tick();
  await ctx.gateway.receive(inTopic(chat.topicId, { text: 'с телефона' }));
  await spin(ctx.gateway);
  release(); await mirroring; await settle(ctx.gateway);
  assert.ok(!ctx.api.of('sendText').some(c => /not running/.test(c.text)), 'user got "✗ Claude session is not running."');
});

test('L3 a linked file that cannot be sent is reported, not promised as "(файл ниже)"', async () => {
  const ctx = setup();
  const { runner } = await startChat(ctx);
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'Отчёт: [pdf](/nonexistent/report.pdf)', duration_ms: 1, uuid: 'r9' });
  await settle(ctx.gateway);
  assert.match(ctx.api.of('sendAnswer')[0].text, /файл ниже/);
  assert.ok(ctx.api.of('sendText').some(c => /report\.pdf/.test(c.text)), 'silently skipped: no file and no error line');
});

test('M10 a transient network error while sending the answer does not lose it and does not leave a live card forever', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  ctx.api.failOnce.push({ method: 'sendAnswer', test: () => true });
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'Итог работы', duration_ms: 1, uuid: 'r10' });
  await settle(ctx.gateway);
  const now = ctx.state.chat(chat.id);
  assert.notEqual(now.status, 'active', 'card keeps ticking with ■ Стоп although the turn is over');
  assert.ok(ctx.api.of('sendAnswer').some(c => c.text === 'Итог работы') || ctx.api.of('sendText').some(c => /не доставлен|Итог работы/.test(c.text)), 'answer lost without retry or notice');
});

test('M11 tool_use heartbeats of a background subagent do not reopen a finished turn', async () => {
  const fq = fakeQuery();
  const ctx = setup({ runnerFactory: options => new ClaudeRunner({ ...options, env: {}, queryImpl: fq.queryImpl }).start() });
  const { chat } = await startChat(ctx);
  fq.emit({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5', session_id: chat.id });
  fq.emit({ type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'toolu_bg', task_type: 'local_agent', is_backgrounded: true, description: 'аудит' });
  fq.emit({ type: 'result', subtype: 'success', is_error: false, result: 'Запустил аудит в фоне', duration_ms: 1, uuid: 'm11', queued_turn_count: 0 });
  await settle(ctx.gateway);
  assert.equal(ctx.state.chat(chat.id).status, 'idle');
  // SDK default: subagent tool_use blocks are forwarded with parent_tool_use_id (heartbeat).
  fq.emit({ type: 'assistant', parent_tool_use_id: 'toolu_bg', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/a' } }] } });
  await settle(ctx.gateway);
  const now = ctx.state.chat(chat.id);
  assert.equal(now.status, 'idle', `background agent heartbeat opened a new ▶ turn (trigger=${now.trigger})`);
  assert.equal(ctx.gateway.runners.get(chat.id).active, false, 'runner marked active: owner messages become steers, /stop interrupts nothing');
});

// Fakes keep promises/intervals open on purpose; do not let them turn into a file-level "cancelled".
after(() => setTimeout(() => process.exit(), 200));
