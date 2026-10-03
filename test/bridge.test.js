import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { finalText } from '../src/codex.js';
import { normalizeEvent, splitText } from '../src/feishu.js';

const baseTime = 1790924000000;
const a = { id: 'aaaaaaaa-1111', title: '原项目 A', kind: 'codex', hostId: 'local', status: 'idle', updatedAt: baseTime / 1000 };
const b = { ...a, id: 'bbbbbbbb-2222', title: '原项目 B' };
function fixture(t, { owner = true, locked = false } = {}) {
  const root = resolve('.cache', 'tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'run-'));
  t.after(() => { assert.ok(resolve(dir).startsWith(root + sep)); rmSync(dir, { recursive: true, force: true }); });
  const store = new Store(join(dir, 'state.json'));
  if (owner) store.data.owner = { userId: 'owner', chatId: 'private' };
  store.data.activeThread = a.id;
  store.data.chatLocked = locked;
  let now = baseTime;
  const sent = [], prompts = [];
  const history = new Map([[a.id, []], [b.id, []]]);
  const codex = {
    list: async () => [a, b],
    read: async id => ({ thread: id === a.id ? a : b, turns: history.get(id) ?? [], page: {} }),
    send: async (threadId, prompt) => { prompts.push({ threadId, prompt }); return {}; },
  };
  const channel = { text: async (chatId, text, key) => { sent.push({ chatId, text, key }); return `message-${sent.length}`; } };
  const bridge = new Bridge({ store, codex, channel, clock: () => now, log() {} });
  const message = (text, overrides = {}) => ({ id: `incoming-${Math.random()}`, userId: 'owner', chatId: 'private', createdAt: now + 1, text, ...overrides });
  return { store, bridge, sent, prompts, history, codex, channel, message, dir, setTime: value => { now = value; } };
}
const turn = (id, completedAt, items = [{ type: 'agentMessage', phase: 'final_answer', text: '最终结果' }]) => ({ id, status: 'completed', completedAt, items });

test('text-only release rejects preview and screenshot commands without sending a Codex prompt', async t => {
  const f = fixture(t);
  for (const command of ['/预览', '/网页截图']) await assert.rejects(f.bridge.handle(f.message(command), {}), /未知命令/);
  assert.equal(f.prompts.length, 0);
});

test('only marked final answers are extracted; no reasoning, commentary or tool output', () => {
  assert.equal(finalText({ items: [
    { type: 'reasoning', text: 'secret reasoning' }, { type: 'agentMessage', phase: 'commentary', text: 'progress' },
    { type: 'commandExecution', text: 'tool log' }, { type: 'agentMessage', text: 'unclassified' },
    { type: 'agentMessage', phase: 'final_answer', text: 'result' },
  ] }), 'result');
});

test('old results are skipped, new completions are delivered only once', async t => {
  const f = fixture(t);
  f.history.set(a.id, [turn('old', (baseTime - 10000) / 1000), turn('new', (baseTime + 10000) / 1000)]);
  await f.bridge.poll(); await f.bridge.flush(); await f.bridge.poll(); await f.bridge.flush();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /最终结果/);
  assert.equal(f.sent[0].chatId, 'private');
});

test('partial active turns never produce a completion notification', async t => {
  const f = fixture(t);
  f.history.set(a.id, [{ ...turn('working', baseTime / 1000), status: 'inProgress' }]);
  await f.bridge.poll(); await f.bridge.flush();
  assert.equal(f.sent.length, 0);
});

test('failed turns notify without including tool logs', async t => {
  const f = fixture(t);
  f.history.set(a.id, [{ ...turn('bad', baseTime / 1000, [{ type: 'commandExecution', text: 'secret' }]), status: 'failed' }]);
  await f.bridge.poll(); await f.bridge.flush();
  assert.match(f.sent[0].text, /失败/);
  assert.ok(!f.sent[0].text.includes('secret'));
});

test('pairing requires the local code and authorizes only one p2p identity', async t => {
  const f = fixture(t, { owner: false });
  f.bridge.receive(f.message('/绑定 wrong'));
  assert.equal(f.store.data.owner, null);
  f.bridge.receive(f.message('/绑定 ' + f.bridge.pairCode));
  assert.equal(f.store.data.owner.userId, 'owner');
  f.bridge.receive(f.message('do work', { userId: 'stranger' }));
  f.bridge.receive(f.message('do work', { chatId: 'different-chat' }));
  await f.bridge.processInbox();
  assert.equal(f.prompts.length, 0);
});

test('duplicate incoming events execute a prompt once', async t => {
  const f = fixture(t);
  const msg = f.message('继续修改页面', { id: 'same' });
  f.bridge.receive(msg); f.bridge.receive(msg);
  await f.bridge.processInbox(); await f.bridge.processInbox();
  assert.deepEqual(f.prompts, [{ threadId: a.id, prompt: '继续修改页面' }]);
});

test('quoted result routes to its original thread even after selection changed', async t => {
  const f = fixture(t);
  f.store.data.routes['result-a'] = a.id;
  f.store.data.activeThread = b.id;
  f.bridge.receive(f.message('接着修改 A', { replyTo: 'result-a' }));
  await f.bridge.processInbox();
  assert.equal(f.prompts[0].threadId, a.id);
});

test('unknown quotes fail closed instead of modifying the selected project', async t => {
  const f = fixture(t);
  f.bridge.receive(f.message('继续', { replyTo: 'unknown' }));
  await f.bridge.processInbox();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.store.data.inbox[0].status, 'failed');
});

test('chat lock and notification mute are independent controls', async t => {
  const f = fixture(t);
  await f.bridge.handle({ text: '/静音' }, {});
  await f.bridge.handle({ text: '/锁定' }, {});
  await f.bridge.handle({ text: '/解锁' }, {});
  assert.equal(f.store.data.muted, true);
  assert.equal(f.store.data.chatLocked, false);
  await f.bridge.handle({ text: '/锁定' }, {});
  await f.bridge.handle({ text: '/通知' }, {});
  assert.equal(f.store.data.muted, false);
  assert.equal(f.store.data.chatLocked, true);
});

test('mute discards queued notices; unmute does not replay old results', async t => {
  const f = fixture(t);
  f.bridge.enqueue('pending old result', { notice: true });
  f.bridge.receive(f.message('/静音')); await f.bridge.processInbox();
  assert.ok(f.store.data.outbox.every(j => !j.notice));
  f.history.set(a.id, [turn('muted', (baseTime + 10000) / 1000)]);
  await f.bridge.poll();
  f.setTime(baseTime + 20000);
  f.bridge.receive(f.message('/通知')); await f.bridge.processInbox(); await f.bridge.poll();
  assert.ok(f.store.data.outbox.every(j => !j.notice));
});

test('restart does not replay queued commands or old pending deliveries', t => {
  const f = fixture(t);
  f.store.data.inbox = [{ message: f.message('uncertain'), status: 'processing' }, { message: f.message('pending'), status: 'pending' }];
  f.bridge.enqueue('old'); f.store.save();
  const reload = new Store(join(f.dir, 'state.json'));
  new Bridge({ store: reload, codex: f.codex, channel: f.channel, clock: () => baseTime + 99999 });
  assert.equal(reload.data.outbox.length, 0);
  assert.deepEqual(reload.data.inbox.map(j => j.status), ['uncertain', 'skipped']);
});

test('pre-start mobile messages are not executed on reconnect', async t => {
  const f = fixture(t);
  f.bridge.receive(f.message('old command', { createdAt: baseTime - 100 }));
  await f.bridge.processInbox();
  assert.equal(f.prompts.length, 0);
});

test('uncertain Codex submission is recorded and never retried automatically', async t => {
  const f = fixture(t);
  let calls = 0;
  f.codex.send = async () => { calls++; throw new Error('timeout'); };
  f.bridge.receive(f.message('change page'));
  await f.bridge.processInbox(); await f.bridge.processInbox();
  assert.equal(calls, 1);
  assert.equal(f.store.data.inbox[0].status, 'uncertain');
});

test('outbound retry uses the same delivery key and preserves complete UTF-8 text', async t => {
  const f = fixture(t);
  const keys = [];
  f.channel.text = async (_chat, _text, key) => { keys.push(key); if (keys.length === 1) throw new Error('network'); return 'sent'; };
  f.bridge.enqueue('中🙂'.repeat(5000), { threadId: a.id, key: 'result' });
  await f.bridge.flush(); f.setTime(baseTime + 100000); await f.bridge.flush();
  assert.equal(keys[0], keys[1]);
  assert.ok(f.store.data.outbox[0].chunks.every(s => Buffer.byteLength(s) <= 12000));
  assert.equal(f.store.data.outbox[0].chunks.join(''), '中🙂'.repeat(5000));
});

test('shutdown stops future messages and does not stop desktop Codex', async t => {
  const f = fixture(t);
  f.bridge.enqueue('pending'); f.bridge.shutdown();
  f.bridge.receive(f.message('late')); await f.bridge.flush(); await f.bridge.poll();
  assert.equal(f.sent.length, 0); assert.equal(f.prompts.length, 0);
});

test('shutdown during preflight prevents a later Codex write', async t => {
  const f = fixture(t);
  let release;
  f.codex.read = () => new Promise(resolve => { release = resolve; });
  f.bridge.receive(f.message('work'));
  const working = f.bridge.processInbox();
  f.bridge.shutdown(); release({}); await working;
  assert.equal(f.prompts.length, 0);
});

test('event adapter rejects group messages and bot loops', () => {
  const event = { sender: { sender_type: 'user', sender_id: { open_id: 'u' } }, message: { chat_type: 'p2p', chat_id: 'c', message_id: 'm', message_type: 'text', content: '{"text":"hello"}', create_time: '123' } };
  assert.equal(normalizeEvent(event).text, 'hello');
  assert.equal(normalizeEvent({ ...event, message: { ...event.message, chat_type: 'group' } }), null);
  assert.equal(normalizeEvent({ ...event, sender: { ...event.sender, sender_type: 'app' } }), null);
});

test('UTF-8 splitting never corrupts Chinese or emoji', () => {
  const text = '中文🙂\n'.repeat(1000);
  const parts = splitText(text, 100);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => Buffer.byteLength(p) <= 100 && !p.includes('\ufffd')));
});

test('corrupt state fails instead of forgetting the bound owner', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'state.json'), 'broken');
  assert.throws(() => new Store(join(f.dir, 'state.json')), /不会覆盖/);
});

test('locked mode rejects quotes from a previously selected conversation', async t => {
  const f = fixture(t, { locked: true });
  f.store.data.routes['result-a'] = a.id;
  f.store.data.activeThread = b.id;
  f.bridge.receive(f.message('接着修改 A', { replyTo: 'result-a' }));
  await f.bridge.processInbox();
  assert.equal(f.prompts.length, 0);
  assert.ok(f.store.data.outbox.some(job => job.chunks.join('').includes('其他聊天')));
});

test('locked notification polling reads only the selected chat and never searches other chats', async t => {
  const f = fixture(t, { locked: true }), reads = [];
  f.codex.list = async () => { throw new Error('automatic listing is forbidden'); };
  const read = f.codex.read;
  f.codex.read = async id => { reads.push(id); return read(id); };
  f.store.data.tracked = [b.id];
  f.history.set(b.id, [turn('other-result', (baseTime + 1000) / 1000)]);
  await f.bridge.poll();
  assert.deepEqual(reads, [a.id]);
  assert.equal(f.store.data.outbox.length, 0);
  f.store.data.activeThread = null;
  await f.bridge.poll();
  assert.deepEqual(reads, [a.id]);
});

test('locked explicit reply cannot target a different chat or cause an automatic search', async t => {
  const f = fixture(t, { locked: true });
  f.codex.list = async () => { throw new Error('no search'); };
  f.bridge.receive(f.message(`/回复 ${b.id} continue`)); await f.bridge.processInbox();
  assert.equal(f.prompts.length, 0);
  f.bridge.receive(f.message(`/回复 ${a.id} continue`)); await f.bridge.processInbox();
  assert.deepEqual(f.prompts, [{ threadId: a.id, prompt: 'continue' }]);
});

test('switching while locked clears previous-chat deliveries and discards an in-flight read', async t => {
  const f = fixture(t, { locked: true });
  f.bridge.threads = [a, b];
  f.bridge.enqueue('old pending result', { threadId: a.id, notice: true });
  let release;
  f.codex.read = async id => id === a.id ? new Promise(resolve => { release = resolve; })
    : { thread: b, turns: [], page: {} };
  const polling = f.bridge.poll();
  f.setTime(baseTime + 2000);
  f.bridge.receive(f.message(`/切换 ${b.id}`)); await f.bridge.processInbox();
  release({ thread: a, turns: [turn('late-old-chat', (baseTime + 3000) / 1000)], page: {} });
  await polling;
  assert.equal(f.store.data.activeThread, b.id);
  assert.ok(f.store.data.outbox.every(job => job.threadId !== a.id));
  assert.equal(f.store.data.activeThreadTitle, b.title);
});

test('unlocked mode notifies multiple chats and replies to quotes without changing the default', async t => {
  const f = fixture(t);
  f.history.set(a.id, [turn('a-result', (baseTime + 1000) / 1000)]);
  f.history.set(b.id, [turn('b-result', (baseTime + 1000) / 1000)]);
  await f.bridge.poll();
  while (f.store.data.outbox.length) await f.bridge.flush();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(new Set(Object.values(f.store.data.routes)), new Set([a.id, b.id]));
  const bMessage = Object.entries(f.store.data.routes).find(([, id]) => id === b.id)[0];
  f.bridge.receive(f.message('继续 B', { replyTo: bMessage })); await f.bridge.processInbox();
  f.bridge.receive(f.message('直接继续')); await f.bridge.processInbox();
  f.bridge.receive(f.message(`/回复 ${b.id} 明确回复 B`)); await f.bridge.processInbox();
  assert.deepEqual(f.prompts, [
    { threadId: b.id, prompt: '继续 B' }, { threadId: a.id, prompt: '直接继续' }, { threadId: b.id, prompt: '明确回复 B' },
  ]);
  assert.equal(f.store.data.activeThread, a.id);
});

test('unlocked polling includes previously chosen chats outside the recent list and works without a default', async t => {
  const f = fixture(t), reads = [];
  f.store.data.activeThread = null;
  f.store.data.tracked = [a.id];
  f.codex.list = async () => [b];
  const read = f.codex.read;
  f.codex.read = async id => { reads.push(id); return read(id); };
  f.history.set(a.id, [turn('tracked-result', (baseTime + 1000) / 1000)]);
  f.history.set(b.id, [turn('listed-result', (baseTime + 1000) / 1000)]);
  await f.bridge.poll();
  assert.deepEqual(new Set(reads), new Set([a.id, b.id]));
  assert.equal(f.store.data.outbox.filter(job => job.notice).length, 2);
});

test('lock switch discards queued outside results and unlock skips locked-period history', async t => {
  const f = fixture(t);
  f.bridge.enqueue('queued B', { threadId: b.id, notice: true });
  f.bridge.receive(f.message('/锁定')); await f.bridge.processInbox();
  assert.equal(f.store.data.chatLocked, true);
  assert.ok(f.store.data.outbox.every(job => job.threadId !== b.id));
  f.history.set(b.id, [turn('during-lock', (baseTime + 1000) / 1000)]);
  await f.bridge.poll();
  f.setTime(baseTime + 2000);
  f.bridge.receive(f.message('/解锁')); await f.bridge.processInbox();
  f.history.set(b.id, [turn('after-unlock', (baseTime + 3000) / 1000), ...f.history.get(b.id)]);
  await f.bridge.poll();
  assert.equal(f.store.data.chatLocked, false);
  assert.deepEqual(f.store.data.outbox.filter(job => job.notice).map(job => job.key), [`${b.id}:after-unlock`]);
  assert.equal(f.store.data.activeThread, a.id);
});

test('lock preference survives restart while existing users start unlocked', async t => {
  const f = fixture(t);
  f.bridge.receive(f.message('/锁定')); await f.bridge.processInbox();
  let reload = new Store(join(f.dir, 'state.json'));
  let bridge = new Bridge({ store: reload, codex: f.codex, channel: f.channel, clock: () => baseTime + 1000 });
  assert.equal(reload.data.chatLocked, true);
  await bridge.handle({ text: '/解锁' }, {});
  reload = new Store(join(f.dir, 'state.json'));
  new Bridge({ store: reload, codex: f.codex, channel: f.channel });
  assert.equal(reload.data.chatLocked, false);
  delete reload.data.chatLocked;
  new Bridge({ store: reload, codex: f.codex, channel: f.channel });
  assert.equal(reload.data.chatLocked, false);
});

test('locking requires a selected chat, rejects extra arguments and status exposes the switch', async t => {
  const f = fixture(t);
  f.store.data.activeThread = null;
  await assert.rejects(f.bridge.handle({ text: '/锁定' }, {}), /选择要锁定/);
  await assert.rejects(f.bridge.handle({ text: '/解锁 extra' }, {}), /不需要额外参数/);
  f.store.data.activeThread = a.id;
  await f.bridge.handle({ text: '/锁定' }, {});
  await f.bridge.handle({ text: '/状态' }, {});
  assert.ok(f.store.data.outbox.some(job => job.chunks.join('').includes('对话锁定：开启')));
  await f.bridge.handle({ text: '/解锁' }, {});
  await f.bridge.handle({ text: '/状态' }, {});
  assert.ok(f.store.data.outbox.some(job => job.chunks.join('').includes('对话锁定：关闭')));
});

test('switching while unlocked preserves other-chat deliveries and in-flight results', async t => {
  const f = fixture(t);
  f.bridge.threads = [a, b];
  f.bridge.enqueue('pending A', { threadId: a.id, notice: true });
  let release;
  f.codex.read = async id => id === a.id ? new Promise(resolve => { release = resolve; }) : { thread: b, turns: [] };
  const pending = f.bridge.poll(); await new Promise(resolve => setImmediate(resolve));
  f.setTime(baseTime + 2000);
  await f.bridge.handle({ text: `/切换 ${b.id}` }, {});
  release({ thread: a, turns: [turn('recent-A', (baseTime + 1000) / 1000)], page: {} }); await pending;
  assert.equal(f.store.data.activeThreadTitle, b.title);
  assert.equal(f.store.data.outbox.filter(job => job.threadId === a.id && job.notice).length, 2);
});

test('locking during an outside chat read discards its late result', async t => {
  const f = fixture(t);
  f.codex.list = async () => [b];
  let release;
  f.codex.read = () => new Promise(resolve => { release = resolve; });
  const pending = f.bridge.poll(); await new Promise(resolve => setImmediate(resolve));
  await f.bridge.handle({ text: '/锁定' }, {});
  release({ thread: b, turns: [turn('late-B', (baseTime + 1000) / 1000)] }); await pending;
  assert.ok(f.store.data.outbox.every(job => job.threadId !== b.id));
});

test('unchanged idle chats are cached but active status objects are read on every poll', async t => {
  const f = fixture(t), reads = [];
  f.codex.list = async () => [a, { ...b, status: { type: 'active' } }];
  const read = f.codex.read;
  f.codex.read = async id => { reads.push(id); return read(id); };
  await f.bridge.poll(); await f.bridge.poll();
  assert.deepEqual(reads, [a.id, b.id, b.id]);
  f.setTime(baseTime + 61000); await f.bridge.poll();
  assert.deepEqual(reads, [a.id, b.id, b.id, a.id, b.id]);
});
