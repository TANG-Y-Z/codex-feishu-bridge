import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.data', { recursive: true });
writeFileSync('.data/stop.request', 'stop\n');
console.log('已请求关闭机器人；正在运行的进程会在下一次检查时退出。');
