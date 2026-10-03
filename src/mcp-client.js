import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Use the installed app-tools MCP, including its validation and host-side checks.
// This adapter is version-sensitive: it is not the public Codex app-server API.
export class McpClient {
  constructor({ serverPath, pipePath, callerThreadId, nodePath = process.execPath }, { timeoutMs = 30000 } = {}) {
    this.config = { serverPath, pipePath, callerThreadId, nodePath };
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.open().catch(error => { this.close(); throw error; });
    return this.ready;
  }

  async open() {
    const { serverPath, pipePath, nodePath } = this.config;
    this.child = spawn(nodePath, [serverPath], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipePath },
    });
    const child = this.child;
    this.stderr = '';
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-2000); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => {
      if (this.child === child) this.fail(new Error('Codex 连接已关闭；请打开桌面应用并重新运行 npm run setup:codex。'));
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return this.fail(new Error('Codex MCP 返回了无效数据。')); }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-feishu-bridge', version: '0.1.1' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const catalog = await this.request('tools/list', {});
    this.tools = new Set(catalog.tools.map(tool => tool.name));
    for (const name of ['list_threads', 'read_thread', 'send_message_to_thread']) {
      if (!this.tools.has(name)) throw new Error(`本机 Codex 不提供 ${name}；请运行 doctor 检查兼容性。`);
    }
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时；写入请求不会自动重发，请先检查原聊天。`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(name, args = {}) {
    await this.connect();
    // Only these three tools are exposed by the bridge. No generic remote tool execution.
    if (!['list_threads', 'read_thread', 'send_message_to_thread'].includes(name)) throw new Error('不支持的工具。');
    const result = await this.request('tools/call', {
      name, arguments: args,
      _meta: { threadId: this.config.callerThreadId },
    });
    const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
    if (result.isError) throw new Error(text || 'Codex 请求失败。');
    try { return JSON.parse(text); } catch { return { text }; }
  }

  fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.ready = null;
  }

  close() {
    this.lines?.close();
    this.child?.kill();
    this.child = null;
    this.fail(new Error('连接已关闭。'));
  }
}
