export class CodexDesktop {
  constructor(client) { this.client = client; }

  async list() {
    const result = await this.client.call('list_threads', { limit: 50 });
    const unique = new Map();
    for (const t of [...(result.pinnedThreads ?? []), ...(result.threads ?? [])]) {
      if (t.kind === 'codex' && t.hostId === 'local') unique.set(t.id, t);
    }
    return [...unique.values()];
  }

  read(threadId, cursor) {
    return this.client.call('read_thread', {
      threadId, hostId: 'local', turnLimit: 10, includeOutputs: false,
      ...(cursor ? { cursor } : {}),
    });
  }

  // Never retry a write with an uncertain result: app-tools has no idempotency key.
  send(threadId, prompt) {
    return this.client.call('send_message_to_thread', { threadId, hostId: 'local', prompt });
  }
}

export function finalText(turn) {
  // Fail closed for unknown phases: never guess that commentary is the final answer.
  return (turn.items ?? [])
    .filter(item => item.type === 'agentMessage' && item.phase === 'final_answer')
    .map(item => item.text ?? '').filter(Boolean).join('\n\n');
}

export function turnFinishedAfter(turn, timestamp) {
  if (!['completed', 'failed', 'interrupted'].includes(turn.status)) return false;
  const value = turn.completedAt;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return (value < 1e12 ? value * 1000 : value) >= timestamp;
}

export function turnNotice(thread, turn) {
  const status = { completed: '已完成', failed: '失败', interrupted: '已中断' }[turn.status];
  const result = finalText(turn);
  const content = result || (turn.status === 'failed'
    ? '任务失败，请打开原聊天查看错误。'
    : turn.status === 'interrupted' ? '任务已中断。' : '本轮已结束，但没有带最终答复标记的文字，请打开原聊天查看。');
  return `【${status}】\n对话：${thread.title}\n\n${content}\n\n引用回复此消息，可继续这个原聊天。`;
}
