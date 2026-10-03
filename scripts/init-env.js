import { copyFileSync, constants } from 'node:fs';

try {
  copyFileSync('.env.example', '.env', constants.COPYFILE_EXCL);
  console.log('已创建 .env。请在本机编辑器中填写你自己的 App ID 和 App Secret。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env 已存在，保留原有配置。');
}
