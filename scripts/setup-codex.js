import { writeFileSync } from 'node:fs';
import { resolveSetupConfig } from '../src/config.js';

try {
  const config = resolveSetupConfig();
  writeFileSync('bridge.local.json', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log(`已保存本机 Codex 连接信息（${process.platform}/${process.arch}）。bridge.local.json 不可分享或提交到 Git。`);
  console.log('下一步运行 npm run doctor 检查真实连接。未修改 Codex 设置。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
