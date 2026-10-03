import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function initConfig(directory = process.cwd()) {
  const created = [];
  for (const [template, destination] of [['.env.example', '.env'], ['bridge.config.example.json', 'bridge.config.json']]) {
    try {
      writeFileSync(join(directory, destination), readFileSync(join(directory, template)), { flag: 'wx', mode: 0o600 });
      created.push(destination);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return created;
}
