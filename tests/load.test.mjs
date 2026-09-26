// Load: many chats at once with steering, queued requests, stops and slow Telegram calls.
// Invariants: every message reaches its own session exactly once, every answer reaches its own
// topic exactly once, no card keeps a live ■ Стоп and no queue is left behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { FakeApi, OWNER, inTopic, nextUpdateId, settle, setup, startChat, tick } from './review-fakes.mjs';

// Seeded, so a failure reproduces.
function random(seed) {
  let x = seed >>> 0;
  return (min, max) => { x = (x * 1664525 + 1013904223) >>> 0; return min + x % (max - min + 1); };
}

class SlowApi extends FakeApi {
  constructor(rand) { super(); this.rand = rand; }
  async guard(method, params) { await tick(this.rand(0, 4)); return super.guard(method, params); }
  async sendText(chatId, text, options = {}) {
    const messages = await super.sendText(chatId, text, options);
    if (options.reply_markup?.inline_keyboard?.length && text.startsWith('<pre>')) this.cardsSent.push(messages[0].message_id);
    return messages;
  }
  cardsSent = [];
}

// Behaves like the CLI: a push while idle starts a turn, a push during a turn folds into it,
// interrupt ends the turn with an error result.
class SimRunner extends EventEmitter {
  constructor(options, sim) {
    super();
    Object.assign(this, options);
    this.sim = sim; this.alive = true; this.active = false; this.closed = false; this.lastActivity = Date.now(); this.pushes = []; this.turns = 0;
  }
  push(content, { priority } = {}) {
    if (!this.alive || this.closed) throw new Error('Claude session is not running.');
    this.pushes.push({ content, priority });
    this.active = true;
    if (this.turn) { this.turn.inputs += 1; return; }
    const turn = this.turn = { n: ++this.turns, inputs: 1 };
    void (async () => {
      await tick(this.sim.rand(5, 40));
      if (this.turn !== turn) return;
      this.emit('message', { type: 'assistant', message: { content: [{ type: 'tool_use', id: randomUUID(), name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 10 } } });
      await tick(this.sim.rand(5, 60));
      if (this.turn !== turn) return;
      this.turn = null; this.active = false;
      const text = `ответ ${this.id} #${turn.n}`;
      if (turn.interrupted) this.emit('message', { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'], duration_ms: 5, uuid: randomUUID() });
      else { this.sim.answers.push({ chatId: this.id, text }); this.emit('message', { type: 'result', subtype: 'success', is_error: false, result: text, duration_ms: 5, uuid: randomUUID() }); }
    })();
  }
  async interrupt() { if (this.turn) this.turn.interrupted = true; }
  async close() { if (this.closed) return; this.closed = true; this.alive = false; this.active = false; this.turn = null; this.emit('exit', null); }
  async contextUsage() { return { totalTokens: 1000, maxTokens: 1000000 }; }
  async setModel() {} async setEffort() {}
}

const texts = runner => runner.pushes.flatMap(p => p.content.filter(c => c.type === 'text').map(c => c.text));

// LOAD_SEEDS=60 npm test — a longer sweep.
const seeds = process.env.LOAD_SEEDS ? Array.from({ length: Number(process.env.LOAD_SEEDS) }, (_, i) => i + 100) : [1, 7, 42];
for (const seed of seeds) {
  test(`eight chats at once keep every message and answer in place (seed ${seed})`, async () => {
    const rand = random(seed);
    const sim = { rand, answers: [] };
    const runners = [];
    const ctx = setup({ api: new SlowApi(rand), runnerFactory: options => { const r = new SimRunner(options, sim); runners.push(r); return r; } });
    const errors = [];
    const log = ctx.gateway.log.bind(ctx.gateway);
    ctx.gateway.log = (kind, error) => { if (!/draft|reaction/.test(kind)) errors.push(`${kind}: ${error?.message ?? error}`); log(kind, error); };

    const chats = [];
    for (let i = 0; i < 8; i++) chats.push((await startChat(ctx, `start-${i}`)).chat);
    const sent = new Map(chats.map(c => [c.id, [`start-${chats.indexOf(c)}`]]));
    const work = [];
    for (let step = 0; step < 160; step++) {
      const chat = chats[rand(0, chats.length - 1)];
      const kind = rand(0, 99);
      const text = `m-${step}`;
      if (kind < 60) { sent.get(chat.id).push(text); work.push(ctx.gateway.receive(inTopic(chat.topicId, { text }))); }
      else if (kind < 80) { sent.get(chat.id).push(text); work.push(ctx.gateway.receive(inTopic(chat.topicId, { text: `/queue ${text}` }))); }
      else if (kind < 86) work.push(ctx.gateway.receive(inTopic(chat.topicId, { text: '/stop' })));
      else if (kind < 92) work.push(ctx.gateway.receive(inTopic(chat.topicId, { text: '/context' })));
      else work.push(ctx.gateway.receive({ update_id: nextUpdateId(), callback_query: { id: 'cb', from: { id: OWNER, is_bot: false },
        data: ctx.gateway.button('x', 'queue_resume', { chatId: chat.id }).callback_data, message: { message_id: 77, chat: { id: OWNER, type: 'private' } } } }));
      if (rand(0, 3) === 0) await tick(rand(1, 30));
    }
    await Promise.all(work);

    // Let everything finish; stopped chats keep their queue paused until resumed.
    for (let round = 0; round < 200; round++) {
      await settle(ctx.gateway, 2);
      await tick(20);
      const open = ctx.state.chats().filter(c => c.status === 'active' || ctx.state.queuedTurns(c.id).some(i => i.status === 'waiting'));
      const g = ctx.gateway;
      const busy = g.chains.size || g.tasks.size || g.workers.size || g.turnLocks.size || g.cardLocks.size || g.mirrors.size;
      if (!open.length && !ctx.state.pending().length && !busy) break;
      for (const c of open) if (c.queuePaused && c.status !== 'active') { ctx.gateway.save({ id: c.id, queuePaused: false }); void ctx.gateway.runQueued(c.id); }
    }

    for (const chat of chats) {
      const got = runners.filter(r => r.id === chat.id).flatMap(texts);
      assert.deepEqual([...got].sort(), [...sent.get(chat.id)].sort(), `chat ${chats.indexOf(chat)}: messages lost or duplicated`);
      const now = ctx.state.chat(chat.id);
      assert.equal(now.status, 'idle', `chat ${chats.indexOf(chat)} left ${now.status}`);
      assert.equal(now.statusMessageId, null, `chat ${chats.indexOf(chat)} left an open card`);
      assert.deepEqual(ctx.state.queuedTurns(chat.id), [], `chat ${chats.indexOf(chat)} left its queue`);
    }
    const delivered = ctx.api.of('sendAnswer');
    for (const answer of sim.answers) {
      const copies = delivered.filter(d => d.text === answer.text);
      assert.equal(copies.length, 1, `${answer.text} delivered ${copies.length}×`);
      assert.equal(copies[0].message_thread_id, ctx.state.chat(answer.chatId).topicId, `${answer.text} went to another topic`);
    }
    assert.equal(delivered.length, sim.answers.length);
    // Every card that ever had ■ Стоп ends without buttons (a second card for one turn would stay live).
    const cards = new Map(ctx.api.cardsSent.map(id => [id, 1]));
    for (const call of ctx.api.calls) {
      const id = call.method === 'editText' ? call.params.messageId : null;
      if (id) cards.set(id, call.params.reply_markup?.inline_keyboard?.length ?? 0);
    }
    assert.deepEqual([...cards.entries()].filter(([, buttons]) => buttons > 0), [], 'a card still shows ■ Стоп');
    assert.deepEqual(errors, []);
  });
}
