import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { finalText, turnFinishedAfter, turnNotice } from './codex.js';
import { splitText } from './feishu.js';

export const HELP = `Codex 手机助手（仅本人私聊）
/会话 — 列出电脑上已有的聊天
/切换 编号或会话ID — 选择后续指令进入的聊天
/回复 会话ID 指令 — 指定原聊天发送
/结果 — 查看当前聊天最近一次最终答复
/状态 — 查看当前聊天和通知状态
/静音 — 暂停自动推送，仍可发指令
/通知 — 恢复推送，不补发静音期间结果
/关闭 — 关闭桥接，之后需在电脑重新启动

直接发送文字会进入当前选中的原聊天。
引用机器人的结果消息再回复，会进入该结果所属聊天。
输入 /帮助 再次查看本说明。`;

export class Bridge {
  constructor({ store, codex, channel, clock = Date.now, log = console.log, stop = () => {} }) {
    Object.assign(this, { store, codex, channel, clock, log, stop });
    this.startedAt = clock();
    this.notifyAfter = this.startedAt;
    this.pairCode = randomBytes(6).toString('hex');
    this.pairExpires = clock() + 10 * 60000;
    this.pairAttempts = 0;
    this.threads = [];
    this.revisions = new Map();
    this.lastRead = new Map();
    this.closed = false;
    this.polling = false;
    this.processing = false;
    this.sending = false;
    // A deliberate restart does not replay yesterday's notifications or phone commands.
    store.data.outbox = [];
    for (const job of store.data.inbox) {
      if (job.status === 'processing') job.status = 'uncertain';
      if (job.status === 'pending') job.status = 'skipped';
    }
    store.save();
  }

  enqueue(text, { threadId = null, notice = false, key = randomUUID() } = {}) {
    if (this.closed || !this.store.data.owner || (notice && this.store.data.muted)) return;
    this.store.data.outbox.push({ key, chunks: splitText(text), next: 0, threadId, notice, attempts: 0, retryAt: 0 });
    this.store.save();
  }

  receive(message) {
    if (this.closed || !message.text || !Number.isFinite(message.createdAt) || message.createdAt < this.startedAt) return;
    const data = this.store.data;
    if (!data.owner) {
      if (!message.text.startsWith('/绑定 ') || this.clock() > this.pairExpires || this.pairAttempts >= 8) return;
      this.pairAttempts++;
      const supplied = Buffer.from(message.text.slice(4).trim());
      const expected = Buffer.from(this.pairCode);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return;
      data.owner = { userId: message.userId, chatId: message.chatId };
      this.store.save();
      this.enqueue('绑定成功。机器人只接受你的私聊指令。\n\n' + HELP);
      return;
    }
    if (message.userId !== data.owner.userId || message.chatId !== data.owner.chatId) return;
    if (data.inbox.some(job => job.message.id === message.id)) return;
    if (data.inbox.filter(job => job.status === 'pending').length >= 30) return;
    data.inbox.push({ message, status: 'pending' });
    data.inbox = data.inbox.slice(-2000);
    this.store.save();
  }

  async refreshThreads() {
    this.threads = await this.codex.list();
    return this.threads;
  }

  resolveThread(selector) {
    if (!selector) return this.store.data.activeThread;
    if (/^\d+$/.test(selector)) {
      const id = this.store.data.listChoices?.[Number(selector) - 1];
      if (!id) throw new Error('编号无效，请先发送 /会话。');
      return id;
    }
    const ids = new Set([...this.threads.map(t => t.id), ...this.store.data.tracked]);
    const matches = [...ids].filter(id => id.startsWith(selector));
    if (matches.length !== 1) throw new Error('会话 ID 不存在或不唯一，请发送 /会话 后选择。');
    return matches[0];
  }

  async processInbox() {
    if (this.processing || this.closed) return;
    this.processing = true;
    try {
      const job = this.store.data.inbox.find(item => item.status === 'pending');
      if (!job) return;
      job.status = 'processing';
      this.store.save();
      try {
        await this.handle(job.message, job);
        job.status = 'done';
      } catch (error) {
        job.status = job.sendingToCodex ? 'uncertain' : 'failed';
        this.enqueue(`${error.message}${job.sendingToCodex ? '\n指令可能已送达，请先检查原聊天；程序不会自动重发。' : ''}`);
      }
      this.store.save();
    } finally { this.processing = false; }
  }

  async handle(message, job) {
    const text = message.text;
    const [command, ...args] = text.split(/\s+/);
    const data = this.store.data;
    if (command === '/帮助' || command === '/help' || command === '/start') return this.enqueue(HELP);
    if (command === '/状态') {
      const uncertain = data.inbox.filter(j => j.status === 'uncertain').length;
      return this.enqueue(`桥接运行中；自动通知：${data.muted ? '已暂停' : '开启'}。\n当前聊天：${data.activeThread ?? '未选择'}\n待核对指令：${uncertain} 条。\n完成结果仅发送最终答复；权限审批仍在 Codex 桌面或 Remote 处理。`);
    }
    if (command === '/静音') {
      data.muted = true;
      data.outbox = data.outbox.filter(job => !job.notice);
      this.store.save();
      return this.enqueue('自动推送已暂停。仍可发指令，发送 /通知 恢复。');
    }
    if (command === '/通知') {
      this.notifyAfter = this.clock();
      data.muted = false;
      this.store.save();
      return this.enqueue('已恢复自动推送，仅通知此刻以后完成的任务。');
    }
    if (command === '/关闭') {
      // No final send after shutdown: stop means no further delivery.
      this.shutdown();
      this.stop();
      return;
    }
    if (command === '/会话') {
      const threads = await this.refreshThreads();
      data.listChoices = threads.map(t => t.id);
      this.store.save();
      return this.enqueue(threads.length ? threads.map((t, i) => `${i + 1}. ${t.title}\n${t.id}`).join('\n\n') + '\n\n发送 /切换 编号 选择。' : '没有找到本地 Codex 聊天。');
    }
    if (command === '/切换') {
      if (!args[0]) throw new Error('用法：/切换 编号或会话ID');
      if (!this.threads.length) await this.refreshThreads();
      const id = this.resolveThread(args[0]);
      const result = await this.codex.read(id);
      data.activeThread = id;
      if (!data.tracked.includes(id)) data.tracked.push(id);
      this.store.save();
      return this.enqueue(`已选择原聊天：${result.thread.title}\n${id}\n后续文字会接着这个聊天继续。`, { threadId: id });
    }
    if (command === '/结果') {
      if (!data.activeThread) throw new Error('请先发送 /会话，再 /切换 编号。');
      const result = await this.codex.read(data.activeThread);
      const turn = result.turns?.find(t => t.status === 'completed' && finalText(t));
      return this.enqueue(turn ? turnNotice(result.thread, turn) : '最近十轮里没有最终答复，请在原聊天查看。', { threadId: data.activeThread });
    }
    let threadId, prompt = text;
    if (command === '/回复') {
      if (args.length < 2) throw new Error('用法：/回复 会话ID 指令');
      if (!this.threads.length) await this.refreshThreads();
      threadId = this.resolveThread(args[0]);
      prompt = text.slice(text.indexOf(args[0]) + args[0].length).trim();
    } else if (command.startsWith('/')) {
      throw new Error('未知命令，发送 /帮助 查看支持的命令。');
    } else if (message.replyTo) {
      threadId = data.routes[message.replyTo];
      if (!threadId) throw new Error('这条引用消息没有关联 Codex 聊天，请使用 /回复 会话ID 指令。');
    } else threadId = data.activeThread;
    if (!threadId) throw new Error('请先发送 /会话，再 /切换 编号，或引用一条任务结果回复。');
    await this.codex.read(threadId); // Resolve permissions/existence before sending.
    if (this.closed) return;
    job.sendingToCodex = true;
    job.threadId = threadId;
    this.store.save();
    await this.codex.send(threadId, prompt);
    this.enqueue(`指令已交给原聊天：${threadId}\n完成后发送最终结果。`, { threadId });
  }

  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const listed = await this.refreshThreads();
      const threads = new Map(listed.map(t => [t.id, t]));
      for (const id of this.store.data.tracked) if (!threads.has(id)) threads.set(id, { id });
      for (const t of threads.values()) {
        if (this.closed) break;
        const revision = `${t.updatedAt}:${JSON.stringify(t.status)}`;
        if (t.updatedAt && this.revisions.get(t.id) === revision && t.status !== 'active'
          && this.clock() - (this.lastRead.get(t.id) ?? 0) < 60000) continue;
        try {
          let cursor, pages = 0;
          do {
            const result = await this.codex.read(t.id, cursor);
            if (this.closed) break;
            let reachedPast = false;
            for (const turn of result.turns ?? []) {
              if (!['completed', 'failed', 'interrupted'].includes(turn.status)) continue;
              const key = `${t.id}:${turn.id}`;
              const fresh = this.store.rememberTurn(key);
              if (!turnFinishedAfter(turn, this.notifyAfter)) { reachedPast = true; continue; }
              if (fresh) this.enqueue(turnNotice(result.thread, turn), { threadId: t.id, notice: true, key });
            }
            cursor = !reachedPast && result.page?.hasMore ? result.page.nextCursor : null;
          } while (cursor && ++pages < 20);
          this.store.save();
          this.revisions.set(t.id, revision);
          this.lastRead.set(t.id, this.clock());
        } catch (error) { this.log(`聊天检查失败：${error.message}`); }
      }
    } finally { this.polling = false; }
  }

  async flush() {
    if (this.sending || this.closed) return;
    this.sending = true;
    try {
      const data = this.store.data;
      const job = data.outbox.find(j => j.retryAt <= this.clock());
      if (!job || !data.owner) return;
      if (job.notice && data.muted) { data.outbox = data.outbox.filter(j => j !== job); this.store.save(); return; }
      try {
        const sendChunk = async () => {
          const id = await this.channel.text(data.owner.chatId, job.chunks[job.next], `${job.key}:${job.next}`);
          if (job.threadId) data.routes[id] = job.threadId;
          job.next++;
        };
        if (job.next < job.chunks.length) await sendChunk();
        if (job.next >= job.chunks.length) data.outbox = data.outbox.filter(j => j !== job);
        const routeKeys = Object.keys(data.routes);
        for (const id of routeKeys.slice(0, Math.max(0, routeKeys.length - 5000))) delete data.routes[id];
        this.store.save();
      } catch (error) {
        job.attempts++;
        job.retryAt = this.clock() + Math.min(300000, 2000 * 2 ** Math.min(job.attempts, 8));
        this.store.save();
        this.log(`消息暂未送达，将重试：${error.message}`);
      }
    } finally { this.sending = false; }
  }

  shutdown() {
    this.closed = true;
    this.store.data.outbox = [];
    this.store.save();
  }
}
