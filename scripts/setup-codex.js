import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH;
const callerThreadId = process.env.CODEX_THREAD_ID;
if (!pipePath || !callerThreadId) {
  console.error('请在 Codex 桌面聊天里，让 Codex 在本项目执行 npm run setup:codex，以保存当前应用提供的连接信息。');
  process.exitCode = 1;
} else {
  const root = join(homedir(), '.codex', 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  const versions = readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const serverPath = versions.map(v => join(root, v, 'server.mjs')).find(existsSync);
  if (!serverPath) throw new Error('没有找到随 Codex 安装的 app-tools MCP。');
  writeFileSync('bridge.local.json', JSON.stringify({ serverPath, pipePath, callerThreadId, nodePath: process.execPath }, null, 2) + '\n', { mode: 0o600 });
  console.log('已保存本机 Codex 连接信息（bridge.local.json，已加入忽略规则）。未修改 Codex 设置。');
}
