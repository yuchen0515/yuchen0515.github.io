import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, 'db.json');
try {
  await fs.access(cache);
  const previous = path.join(root, '.history', 'preview', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  await fs.mkdir(previous, { recursive: true });
  await fs.rename(cache, path.join(previous, 'db.json'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const child = spawn(process.execPath, [path.join(root, 'node_modules', 'hexo', 'bin', 'hexo'), 'server', '--ip', '127.0.0.1', '--config', '_config.yml,_config.preview.yml', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
