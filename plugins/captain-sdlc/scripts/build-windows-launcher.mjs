import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  const result = spawnSync(compiler, ['/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
    `/out:${path.join(root, 'bin', 'captain-hook.exe')}`, path.join(root, 'scripts', 'windows-hook-launcher.cs')],
  { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows hook launcher compilation failed: ${result.status}`);
}
