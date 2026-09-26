// Several chats at once: nothing in one chat may hold another, and races at turn edges stay correct.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Desktop, OWNER, inTopic, message, nextUpdateId, setup, settle, startChat, tick } from './review-fakes.mjs';

const callback = (gateway, type, data) => ({ update_id: nextUpdateId(), callback_query: { id: 'cb', from: { id: OWNER, is_bot: false },
  data: gateway.button('x', type, data).callback_data, message: { message_id: 77, chat: { id: OWNER, type: 'private' } } } });
const record = (fields) => JSON.stringify({ timestamp: new Date().toISOString(), uuid: randomUUID(), entrypoint: 'claude-desktop', ...fields }) + '\n';
const echoes = api => api.of('sendMessage').filter(p => p.text.startsWith('💻'));
// Waits for a condition instead of a fixed pause: a busy machine must not fail the test.
async function until(condition, ms = 5000) {
  for (const deadline = Date.now() + ms; !condition() && Date.now() < deadline;) await tick(10);
  return condition();
}
// A desktop session transcript read by the real Desktop (byte offsets, like the CLI writes them).
function session(ctx) {
  const id = randomUUID();
  const root = join(ctx.dir, 'claude');
  mkdirSync(join(root, 'projects', '-home-user-workspace'), { recursive: true });
  const path = join(root, 'projects', '-home-user-workspace', `${id}.jsonl`);
  writeFileSync(path, '');
  ctx.gateway.desktop = new Desktop({ root });
  ctx.state.saveChat({ id, cwd: '/home/user/workspace', project: 'workspace', title: 'Сессия', origin: 'desktop', started: true, status: 'idle', model: 'opus[1m]', effort: 'xhigh', mirrorOffset: 0 });
  return { id, path };
}

test('a file upload from /files does not hold messages to other chats', async () => {
  const ctx = setup();
  const a = await startChat(ctx, 'чат A');
  const b = await startChat(ctx, 'чат B');
  const path = join(ctx.dir, 'report.txt');
  writeFileSync(path, 'отчёт');
  const file = ctx.state.addFile(a.chat.id, { path, name: 'report.txt', size: 6, direction: 'out' });
  const upload = ctx.api.gate('sendDocument');
  await ctx.gateway.receive(callback(ctx.gateway, 'file', { fileId: file.id }));   // returns while the upload runs
  assert.ok(await until(() => upload.entered));
  await ctx.gateway.receive(inTopic(b.chat.topicId, { text: 'уточнение для B' }));
  assert.ok(await until(() => b.runner.pushes.length === 2), 'chat B waited for chat A\'s upload');
  upload.open();
  await ctx.gateway.idle;
  assert.equal(ctx.api.of('sendDocument').length, 1);
});

test('two mirror passes at once show a desktop prompt once', async () => {
  const ctx = setup();
  const { id, path } = session(ctx);
  await ctx.gateway.ensureTopic(id);
  appendFileSync(path, record({ type: 'user', message: { role: 'user', content: 'сделай отчёт на компьютере' } }));
  await Promise.all([ctx.gateway.pollMirrors(), ctx.gateway.mirror(id), ctx.gateway.mirror(id)]);
  assert.equal(echoes(ctx.api).length, 1);
});

test('reopening a session whose topic was deleted does not flood the new topic with old records', async () => {
  const ctx = setup();
  const { id, path } = session(ctx);
  const topic = await ctx.gateway.ensureTopic(id);
  ctx.api.failTopics.add(topic);   // the owner deleted the topic; the mirror no longer runs for it
  ctx.state.saveChat({ id, topicId: null });
  ctx.state.unbindTopic(topic);
  for (let i = 0; i < 5; i++) appendFileSync(path, record({ type: 'user', message: { role: 'user', content: `старый запрос ${i}` } }));
  await ctx.gateway.callback(callback(ctx.gateway, 'open', { sessionId: id }).callback_query);
  await ctx.gateway.pollMirrors();
  assert.equal(echoes(ctx.api).length, 0);
  appendFileSync(path, record({ type: 'user', message: { role: 'user', content: 'новый запрос' } }));
  await ctx.gateway.pollMirrors();
  assert.deepEqual(echoes(ctx.api).map(p => p.text.includes('новый запрос')), [true]);
});

test('a message sent as the answer arrives starts its own turn and card', async () => {
  const ctx = setup();
  const { chat, runner } = await startChat(ctx);
  runner.emitMessage({ type: 'result', subtype: 'success', is_error: false, result: 'Первый ответ', duration_ms: 1000, uuid: 'r1' });
  await ctx.gateway.receive(inTopic(chat.topicId, { text: 'следующая задача' }));   // same tick as the result
  await settle(ctx.gateway);
  assert.equal(runner.pushes.length, 2);
  assert.equal(runner.pushes[1].priority, undefined, 'steered a turn that had already finished');
  const now = ctx.state.chat(chat.id);
  assert.equal(now.status, 'active');
  assert.equal(now.trigger, null, 'user turn marked as started by itself');
  assert.ok(now.statusMessageId, 'the new turn has no live card');
  const answer = ctx.api.calls.findIndex(c => c.method === 'sendAnswer');
  const card = ctx.api.calls.findLastIndex(c => c.method === 'sendText' && c.params.text.includes('▶'));
  assert.ok(answer >= 0 && answer < card, 'the new card came before the previous answer');
});

test('an album sent to the general chat stays one request when the project line is slow', async () => {
  const ctx = setup();
  ctx.gateway.lastLobby = null;
  const line = ctx.api.gate('sendText', p => p.text.startsWith('📁'));
  const first = ctx.gateway.receive(message({ text: 'первое', media_group_id: 'g7' }));
  await new Promise(resolve => setTimeout(resolve, 1700));
  line.open();
  await first;
  await ctx.gateway.receive(message({ text: 'второе', media_group_id: 'g7' }));
  await new Promise(resolve => setTimeout(resolve, 1700));
  await settle(ctx.gateway);
  assert.equal(ctx.runners.length, 1);
  assert.equal(ctx.runners[0].pushes.length, 1);
  assert.deepEqual(ctx.runners[0].pushes[0].content, [{ type: 'text', text: 'первое\nвторое' }]);
});

test('a chat started in the desktop app gets its topic by itself, mirrored from its first message', async () => {
  const ctx = setup();
  const root = join(ctx.dir, 'claude');
  const dir = join(root, 'projects', '-home-user-workspace');
  mkdirSync(dir, { recursive: true });
  ctx.gateway.desktop = new Desktop({ root });
  const write = (id, entrypoint, records) => appendFileSync(join(dir, `${id}.jsonl`), records.map(r => JSON.stringify({ sessionId: id, cwd: '/home/user/workspace', entrypoint, uuid: randomUUID(), timestamp: new Date().toISOString(), ...r }) + '\n').join(''));
  write(randomUUID(), 'claude-desktop', [{ type: 'user', message: { role: 'user', content: 'старый чат' } }]);
  ctx.state.set('defaultModel', 'claude-opus-5-5[1m]');   // /model in General applies to opened sessions too
  ctx.state.set('defaultEffort', 'medium');
  await ctx.gateway.pollNewSessions();   // switches auto topics on: what is already there stays as it is
  assert.equal(ctx.api.of('createForumTopic').length, 0);
  await tick(5);
  const fresh = randomUUID();
  write(fresh, 'claude-desktop', [{ type: 'user', message: { role: 'user', content: 'новый чат на компьютере' } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'готово с компьютера' }] } }]);
  write(randomUUID(), 'sdk-ts', [{ type: 'user', message: { role: 'user', content: 'чужой скрипт' } }]);
  await ctx.gateway.pollNewSessions();
  assert.equal(ctx.api.of('createForumTopic').length, 1);
  assert.deepEqual([ctx.state.chat(fresh).model, ctx.state.chat(fresh).effort], ['claude-opus-5-5[1m]', 'medium']);
  await ctx.gateway.pollMirrors();
  assert.ok(echoes(ctx.api).some(p => p.text.includes('новый чат на компьютере')));
  assert.deepEqual(ctx.api.of('sendAnswer').map(p => p.text), ['готово с компьютера']);
  ctx.state.saveChat({ id: fresh, archived: true, topicId: null });   // /archive in Telegram
  write(fresh, 'claude-desktop', [{ type: 'user', message: { role: 'user', content: 'ещё' } }]);
  await ctx.gateway.pollNewSessions();
  assert.equal(ctx.api.of('createForumTopic').length, 1, 'an archived chat came back');
});

test('a turn on the computer shows on the card what the agent says between tools', async () => {
  const ctx = setup();
  const { id, path } = session(ctx);
  await ctx.gateway.ensureTopic(id);
  appendFileSync(path, record({ type: 'user', message: { role: 'user', content: 'проверь бота' } }));
  appendFileSync(path, record({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Смотрю журнал службы.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'journalctl -n 20' } }] } }));
  await ctx.gateway.pollMirrors();
  await ctx.gateway.refreshCard(id);
  const card = ctx.api.of('editText').filter(c => c.text.startsWith('<pre>')).at(-1);
  assert.ok(card.text.includes('💻') && card.text.endsWith('</pre>\nСмотрю журнал службы.'), card.text);
  // The desktop app also shows the thinking summary between tools; so does the card.
  appendFileSync(path, record({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'Журнал чистый, проверяю базу.', signature: 'x' }] } }));
  await ctx.gateway.pollMirrors();
  await ctx.gateway.refreshCard(id);
  assert.ok(ctx.api.of('editText').at(-1).text.endsWith('Смотрю журнал службы.\n\nЖурнал чистый, проверяю базу.'));
});
