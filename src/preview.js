import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);

export async function preview({ devtoolsDir, projectPath, outputDir = 'artifacts' }) {
  if (!devtoolsDir || !projectPath) throw new Error('请先在 .env 设置 WECHAT_DEVTOOLS_DIR 和 WECHAT_PROJECT_PATH。');
  const project = resolve(projectPath);
  await access(join(project, 'project.config.json')).catch(() => { throw new Error('预览目录中没有 project.config.json，请指向实际小程序输出目录。'); });
  await mkdir(outputDir, { recursive: true });
  const output = resolve(outputDir, `preview-${randomUUID()}.png`);
  // Fixed executable and discrete arguments: mobile text is never interpolated into a shell.
  await run(join(devtoolsDir, 'node.exe'), [join(devtoolsDir, 'cli.js'), 'preview', '--project', project,
    '--qr-format', 'image', '--qr-output', output, '--lang', 'zh'], {
    windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024,
  }).catch(() => { throw new Error('预览失败或超时，请检查开发者工具登录状态、服务端口和项目编译错误。'); });
  await access(output);
  return output;
}
