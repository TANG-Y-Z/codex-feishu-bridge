import { initConfig } from '../src/init-config.js';

try {
  const created = initConfig();
  console.log(created.length ? `已创建：${created.join('、')}。` : '配置文件已存在，保留原有内容。');
  console.log('在 .env 填写自己的 App ID 和 App Secret；bridge.config.json 的路径通常留空即可。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
