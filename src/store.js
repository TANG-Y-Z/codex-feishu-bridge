import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    this.path = path;
    try { this.data = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('状态文件无法读取；请先备份并检查，程序不会覆盖它。');
      this.data = { owner: null, activeThread: null, muted: false, seen: [], inbox: [], outbox: [], routes: {}, tracked: [] };
    }
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  rememberTurn(key) {
    if (this.data.seen.includes(key)) return false;
    this.data.seen.push(key);
    this.data.seen = this.data.seen.slice(-10000);
    return true;
  }
}
