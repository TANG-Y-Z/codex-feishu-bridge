import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';

const settingKeys = ['codexHome', 'serverPath', 'nodePath'];

export function loadSettings(directory = process.cwd()) {
  let text;
  try { text = readFileSync(join(directory, 'bridge.config.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('bridge.config.json 不是有效 JSON，请检查英文引号、逗号和 Windows 路径的斜杠。'); }
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).some(key => !settingKeys.includes(key))
    || Object.values(value).some(item => typeof item !== 'string')) {
    throw new Error('bridge.config.json 只支持 codexHome、serverPath、nodePath 三个字符串字段；留空表示自动识别。');
  }
  return value;
}

export function expandPath(value, { directory = process.cwd(), home = homedir(), platform = process.platform } = {}) {
  const path = platform === 'win32' ? win32 : posix;
  const input = value.trim();
  if (!input || input.includes('\0') || /[\r\n]/.test(input)) throw new Error('配置路径不能为空或包含换行。');
  if (platform !== 'win32' && (win32.isAbsolute(input) && !posix.isAbsolute(input) || input.includes('\\'))) {
    throw new Error('Mac 路径请使用 / 或 ~/ 开头的本机路径，不能复制 Windows 的盘符或反斜杠。');
  }
  if (input === '~') return home;
  if (input.startsWith('~/') || (platform === 'win32' && input.startsWith('~\\'))) return path.resolve(home, input.slice(2));
  return path.resolve(directory, input);
}

function isFile(path) {
  try { return statSync(path).isFile(); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

export function resolveSetupConfig({ directory = process.cwd(), settings = loadSettings(directory), env = process.env,
  home = homedir(), platform = process.platform, execPath = process.execPath } = {}) {
  // The live IPC endpoint and caller identity must come from this Codex desktop session.
  // Keep them separate from user-editable installation paths and Feishu credentials.
  const pipePath = env.CODEX_APP_TOOLS_PIPE_PATH;
  const callerThreadId = env.CODEX_THREAD_ID;
  if (!pipePath || !callerThreadId) {
    throw new Error('请在本项目的 Codex 桌面聊天里，让 Codex 执行 npm run setup:codex；外部终端不能自动取得当前连接信息。');
  }
  const options = { directory, home, platform };
  const path = platform === 'win32' ? win32 : posix;
  const codexHome = expandPath(settings.codexHome?.trim() || env.CODEX_HOME || path.join(home, '.codex'), options);
  const nodePath = expandPath(settings.nodePath?.trim() || execPath, options);
  if (!isFile(nodePath)) throw new Error('nodePath 未指向有效的 Node.js 可执行文件；请填写完整路径，或留空使用当前 Node。');
  let serverPath;
  if (settings.serverPath?.trim()) {
    serverPath = expandPath(settings.serverPath, options);
    if (!isFile(serverPath)) throw new Error('serverPath 未指向有效文件，请填写本机 codex-app-tools 的 server.mjs 完整路径。');
  } else {
    const root = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      entries = [];
    }
    serverPath = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map(version => path.join(root, version, 'server.mjs')).find(isFile);
    if (!serverPath) throw new Error('没有找到 codex-app-tools/server.mjs。请确认桌面工具已安装，或在 bridge.config.json 指定 codexHome / serverPath 后重试；不要复制他人安装文件。');
  }
  return { serverPath, pipePath, callerThreadId, nodePath };
}

export function loadConnection(directory = process.cwd()) {
  let value;
  try { value = JSON.parse(readFileSync(join(directory, 'bridge.local.json'), 'utf8')); }
  catch { throw new Error('缺少或无法读取 bridge.local.json。请先在本项目的 Codex 桌面聊天里执行 npm run setup:codex。'); }
  if (!value || ['serverPath', 'pipePath', 'callerThreadId', 'nodePath'].some(key => typeof value[key] !== 'string' || !value[key].trim())) {
    throw new Error('本机 Codex 连接配置不完整，请重新执行 npm run setup:codex。');
  }
  if (!isFile(value.serverPath) || !isFile(value.nodePath)) {
    throw new Error('本机 Codex 或 Node.js 路径已失效；修改 bridge.config.json 后，在本项目的 Codex 聊天里重新执行 npm run setup:codex。');
  }
  return value;
}
