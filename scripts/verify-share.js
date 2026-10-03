import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { homedir } from 'node:os';

// Read local credentials only to detect accidental inclusion. Never print values.
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-share.js <staged-directory>');
const directory = resolve(process.argv[2]);
const allowed = JSON.parse(readFileSync(join(sourceRoot, 'scripts/share-files.json'), 'utf8'));
const allowedSet = new Set([...allowed, 'SHARE-MANIFEST.json']);
const privateValues = new Set([homedir(), homedir().replaceAll('\\', '/')]);
const envPath = join(sourceRoot, '.env');
if (existsSync(envPath)) {
  const env = parseEnv(readFileSync(envPath, 'utf8'));
  for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']) if (env[key]) privateValues.add(env[key]);
}
const configPath = join(sourceRoot, 'bridge.local.json');
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  for (const key of ['pipePath', 'callerThreadId', 'serverPath']) {
    const value = config[key];
    if (!value) continue;
    privateValues.add(value);
    privateValues.add(value.replaceAll('\\', '/'));
    privateValues.add(JSON.stringify(value).slice(1, -1));
  }
}

const files = [];
function walk(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (lstatSync(full).isSymbolicLink()) throw new Error('Archive must not contain links.');
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(directory);
const found = new Set();
for (const path of files) {
  const name = relative(directory, path).split(sep).join('/');
  if (!allowedSet.has(name)) throw new Error(`Unexpected file in share package: ${name}`);
  found.add(name);
  const content = readFileSync(path, 'utf8');
  for (const value of privateValues) {
    if (content.includes(value)) throw new Error('Private local value detected in package; no value logged.');
  }
  if (/cli_[0-9a-f]{16}/i.test(content)) throw new Error('A real-looking Feishu App ID was found; inspect locally.');
}
for (const name of allowed) if (!found.has(name)) throw new Error(`Required file is missing: ${name}`);
const template = parseEnv(readFileSync(join(directory, '.env.example'), 'utf8'));
if (template.FEISHU_APP_ID !== '' || template.FEISHU_APP_SECRET !== '') throw new Error('Credential template must be blank.');
const pathsTemplate = JSON.parse(readFileSync(join(directory, 'bridge.config.example.json'), 'utf8'));
if (Object.keys(pathsTemplate).sort().join(',') !== 'codexHome,nodePath,serverPath'
  || Object.values(pathsTemplate).some(value => value !== '')) throw new Error('Path configuration template must be blank.');
console.log(`Share check passed: ${files.length} allowlisted files, blank credentials, no known local secrets or connection identifiers.`);
