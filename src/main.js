import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { McpClient } from './mcp-client.js';
import { CodexDesktop } from './codex.js';
import { Store } from './store.js';
import { Feishu } from './feishu.js';
import { Bridge } from './bridge.js';
import { loadConnection } from './config.js';

const directory = '.data';
mkdirSync(directory, { recursive: true });
const lock = join(directory, 'bridge.lock');
const stopFile = join(directory, 'stop.request');
let client, channel, bridge, timers = [], acquiredLock = false, stopping = false;

function acquireLock() {
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let active = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') active = false; }
    if (active) throw new Error('机器人已经运行，或旧锁无法确认。请先执行 npm run stop。');
    unlinkSync(lock);
  }
  writeFileSync(lock, String(process.pid), { flag: 'wx' });
  acquiredLock = true;
  if (existsSync(stopFile)) unlinkSync(stopFile);
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearInterval(timer);
  bridge?.shutdown();
  channel?.close();
  client?.close();
  if (acquiredLock && existsSync(lock)) unlinkSync(lock);
  if (acquiredLock && existsSync(stopFile)) unlinkSync(stopFile);
  console.log('机器人已关闭，桌面 Codex 继续正常运行。');
  // Terminate only this bridge. Never terminate the desktop app or its Codex worker.
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

try {
  if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) throw new Error('请先复制 .env.example 为 .env，并填写飞书 App ID 和 App Secret。');
  const config = loadConnection();
  acquireLock();
  client = new McpClient(config);
  await client.connect();
  channel = new Feishu(process.env.FEISHU_APP_ID, process.env.FEISHU_APP_SECRET);
  const store = new Store(join(directory, 'state.json'));
  bridge = new Bridge({ store, codex: new CodexDesktop(client), channel, stop });
  console.log('Codex 已连接。正在连接飞书长连接；请在飞书发送 /状态 验证实际收发。');
  if (!store.data.owner) console.log(`首次绑定：在手机私聊机器人发送 /绑定 ${bridge.pairCode}\n绑定码有效期 10 分钟。`);
  await channel.connect(message => bridge.receive(message));
  if (stopping) channel.close();
  else {
    const safely = task => Promise.resolve().then(task).catch(error => console.error(error.message));
    timers.push(setInterval(() => safely(() => bridge.processInbox()), 250));
    timers.push(setInterval(() => safely(() => bridge.flush()), 500));
    timers.push(setInterval(() => safely(() => bridge.poll()), 10000));
    timers.push(setInterval(() => { if (existsSync(stopFile)) stop(); }, 500));
    await safely(() => bridge.poll());
  }
} catch (error) {
  console.error(error.message);
  client?.close();
  channel?.close();
  if (acquiredLock && existsSync(lock)) unlinkSync(lock);
  process.exitCode = 1;
}
