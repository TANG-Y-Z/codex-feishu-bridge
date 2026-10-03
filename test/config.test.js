import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { expandPath, loadSettings, loadConnection, resolveSetupConfig } from '../src/config.js';
import { initConfig } from '../src/init-config.js';

function fixture(t) {
  const root = resolve('.cache', 'tests'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'config with spaces-'));
  t.after(() => { assert.ok(resolve(dir).startsWith(root + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function server(directory, version) {
  const path = join(directory, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', version, 'server.mjs');
  mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, '// test fixture\n');
  return path;
}
const live = { CODEX_APP_TOOLS_PIPE_PATH: '/tmp/local-codex-fixture.sock', CODEX_THREAD_ID: 'fixture-chat' };

test('first-run templates are private and reopening configuration never overwrites personal values', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, '.env.example'), 'FEISHU_APP_ID=\nFEISHU_APP_SECRET=\n');
  writeFileSync(join(dir, 'bridge.config.example.json'), '{"codexHome":"","serverPath":"","nodePath":""}\n');
  assert.deepEqual(initConfig(dir), ['.env', 'bridge.config.json']);
  writeFileSync(join(dir, '.env'), 'FEISHU_APP_SECRET=local-test-value\n');
  writeFileSync(join(dir, 'bridge.config.json'), '{"codexHome":"~/custom-data"}');
  assert.deepEqual(initConfig(dir), []);
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'FEISHU_APP_SECRET=local-test-value\n');
  assert.equal(loadSettings(dir).codexHome, '~/custom-data');
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
});

test('default discovery respects CODEX_HOME, picks a usable version and preserves the live IPC endpoint', t => {
  const dir = fixture(t);
  server(dir, '0.1.9'); const expected = server(dir, '0.1.10');
  mkdirSync(join(dir, 'plugins/cache/openai-bundled/codex-app-tools/0.1.11'));
  const config = resolveSetupConfig({ directory: dir, env: { ...live, CODEX_HOME: dir } });
  assert.equal(config.serverPath, expected);
  assert.equal(config.pipePath, live.CODEX_APP_TOOLS_PIPE_PATH);
  assert.equal(config.callerThreadId, live.CODEX_THREAD_ID);
  assert.equal(config.nodePath, process.execPath);
});

test('home fallback and explicit local paths work in folders containing spaces', t => {
  const dir = fixture(t);
  const expected = server(join(dir, '.codex'), '0.1.5');
  assert.equal(resolveSetupConfig({ directory: dir, env: live, home: dir }).serverPath, expected);
  const custom = server(join(dir, 'custom data'), '0.1.7');
  writeFileSync(join(dir, 'bridge.config.json'), JSON.stringify({ codexHome: './custom data' }));
  assert.equal(resolveSetupConfig({ directory: dir, env: { ...live, CODEX_HOME: 'unused' } }).serverPath, custom);
  writeFileSync(join(dir, 'server.mjs'), '// custom server');
  writeFileSync(join(dir, 'bridge.config.json'), JSON.stringify({ serverPath: './server.mjs', nodePath: process.execPath }));
  assert.equal(resolveSetupConfig({ directory: dir, env: live }).serverPath, join(dir, 'server.mjs'));
});

test('macOS and Windows paths expand without shell evaluation or losing spaces', () => {
  const mac = { platform: 'darwin', home: '/Users/example', directory: '/Users/example/Bridge Bot' };
  assert.equal(expandPath('~/Library/Application Support/Codex', mac), '/Users/example/Library/Application Support/Codex');
  assert.equal(expandPath('./tools/server.mjs', mac), '/Users/example/Bridge Bot/tools/server.mjs');
  assert.equal(expandPath('/opt/homebrew/bin/node', mac), '/opt/homebrew/bin/node');
  assert.throws(() => expandPath('C:\\Tools\\node.exe', mac), /Mac 路径/);
  assert.throws(() => expandPath('C:/Tools/node.exe', mac), /Mac 路径/);
  assert.equal(expandPath('C:/Program Files/nodejs/node.exe', { platform: 'win32', directory: 'D:\\Bridge' }), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(expandPath('~/Tools', { platform: 'win32', home: 'C:\\Users\\example', directory: 'D:\\Bridge' }), 'C:\\Users\\example\\Tools');
});

test('missing context or installation fails with guidance instead of inventing a connection', t => {
  const dir = fixture(t);
  assert.throws(() => resolveSetupConfig({ directory: dir, env: {} }), /Codex 桌面聊天/);
  assert.throws(() => resolveSetupConfig({ directory: dir, env: live, home: dir }), /没有找到 codex-app-tools/);
  assert.throws(() => resolveSetupConfig({ directory: dir, env: live, settings: { serverPath: './missing.mjs' } }), /serverPath/);
  assert.throws(() => resolveSetupConfig({ directory: dir, env: live, settings: { nodePath: './missing-node' } }), /nodePath/);
});

test('editable configuration rejects mistakes and live identity overrides', t => {
  const dir = fixture(t), path = join(dir, 'bridge.config.json');
  assert.deepEqual(loadSettings(dir), {});
  for (const invalid of ['{', 'null', '[]', '{"nodePath":123}', '{"pipePath":"somewhere"}', '{"callerThreadId":"another-chat"}']) {
    writeFileSync(path, invalid); assert.throws(() => loadSettings(dir), /bridge.config.json/);
  }
  writeFileSync(path, '\uFEFF{"nodePath":""}');
  assert.deepEqual(loadSettings(dir), { nodePath: '' });
});

test('runtime detects stale local paths before spawning a process', t => {
  const dir = fixture(t), path = join(dir, 'bridge.local.json');
  assert.throws(() => loadConnection(dir), /setup:codex/);
  writeFileSync(path, '{}'); assert.throws(() => loadConnection(dir), /不完整/);
  const config = { serverPath: server(dir, '0.1.5'), nodePath: process.execPath, pipePath: live.CODEX_APP_TOOLS_PIPE_PATH, callerThreadId: live.CODEX_THREAD_ID };
  writeFileSync(path, JSON.stringify(config)); assert.deepEqual(loadConnection(dir), config);
  writeFileSync(path, JSON.stringify({ ...config, nodePath: join(dir, 'removed-node') }));
  assert.throws(() => loadConnection(dir), /路径已失效/);
});

test('macOS launch files ship with Unix line endings and no UTF-8 BOM', () => {
  for (const path of ['1-安装依赖.command', '2-填写配置.command', '3-启动机器人.command', '4-停止机器人.command', 'scripts/macos-common.sh']) {
    const text = readFileSync(path, 'utf8');
    assert.ok(text.startsWith('#!/bin/bash\n'), path);
    assert.ok(!text.includes('\r'), path);
  }
});
