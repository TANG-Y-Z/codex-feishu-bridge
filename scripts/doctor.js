import { readFileSync } from 'node:fs';
import { McpClient } from '../src/mcp-client.js';
import { CodexDesktop } from '../src/codex.js';

let client;
try {
  const config = JSON.parse(readFileSync('bridge.local.json', 'utf8'));
  client = new McpClient(config);
  const threads = await new CodexDesktop(client).list();
  console.log(`Codex 连接成功，检查到 ${threads.length} 个本地聊天。`);
  if (threads.length) {
    const result = await client.call('read_thread', { threadId: threads[0].id, hostId: 'local', turnLimit: 2, includeOutputs: false });
    console.log(`读取原聊天成功，状态：${result.thread?.status?.type ?? '未知'}。未发送指令。`);
    const completed = result.turns?.find(t => t.status === 'completed');
    if (completed) console.log(`历史完成事件：时间字段 ${typeof completed.completedAt}；最终答复标记 ${completed.items?.some(i => i.type === 'agentMessage' && i.phase === 'final_answer') ? '可用' : '缺失'}。`);
  }
  console.log(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET ? '飞书凭证已填写；尚未验证联网收发。' : '飞书尚未配置：请填写 .env。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { client?.close(); }
