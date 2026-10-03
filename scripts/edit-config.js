import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { initConfig } from '../src/init-config.js';

try {
  initConfig();
  console.log('只在 .env 填写飞书凭证；bridge.config.json 的三项路径默认留空即可。');
  console.log('修改后保存为纯文本。若更改连接路径，停止桥接并重新运行 setup:codex 和 doctor。');
  const files = ['.env', 'bridge.config.json'].map(file => resolve(file));
  const editors = process.platform === 'darwin' ? [['open', ['-a', 'TextEdit', ...files]]]
    : process.platform === 'win32' ? files.map(file => ['notepad.exe', [file]]) : [];
  if (!editors.length) console.log('请使用本机文本编辑器打开 .env 和 bridge.config.json。');
  for (const [program, args] of editors) {
    const child = spawn(program, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => { console.error('无法打开编辑器，请手动编辑 .env 和 bridge.config.json。'); process.exitCode = 1; });
    child.on('exit', code => { if (code) { console.error('编辑器未正常打开，请手动编辑配置文件。'); process.exitCode = 1; } });
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
