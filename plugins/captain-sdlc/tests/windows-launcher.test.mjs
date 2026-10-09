import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(root, 'bin', 'captain-hook.exe');
const run = (args, input = '') => spawnSync(launcher, args, { input, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });

test('launcher has the Windows GUI subsystem so it does not allocate a console', () => {
  const pe = readFileSync(launcher);
  assert.equal(pe.readUInt16LE(pe.readUInt32LE(0x3c) + 24 + 68), 2);
});

test('launcher preserves stdin, Unicode, stdout, stderr and blocking exit code', () => {
  const result = run(['-e', "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.stdout.write(s);process.stderr.write('denied');process.exitCode=2;});"], '{"prompt":"café ☃"}');
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, '{"prompt":"café ☃"}');
  assert.equal(result.stderr, 'denied');
  assert.equal(result.status, 2);
});

test('launcher preserves argument quoting and empty arguments', () => {
  const args = ['space value', 'a"b', 'trailing\\', '', 'C:\\space path\\'];
  const result = run(['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('launcher drains large stdout and stderr without deadlocking', () => {
  const result = run(['-e', "process.stdout.write('o'.repeat(200000));process.stderr.write('e'.repeat(200000));"]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.length, 200000);
  assert.equal(result.stderr.length, 200000);
});

test('Windows overrides route every hook through the hidden launcher', () => {
  const config = JSON.parse(readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  for (const handlers of Object.values(config.hooks)) for (const handler of handlers) {
    assert.match(handler.commandWindows, /captain-hook\.exe/);
    assert.equal(handler.async, undefined);
  }
});

test('actual mutation hook still denies mutations without a permit', () => {
  const result = run([path.join(root, 'scripts', 'mutation-gate.mjs')], JSON.stringify({
    cwd: path.join(root, 'nonexistent-repository'), tool_name: 'apply_patch', tool_input: { command: '*** Add File: example.txt' }
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('cancelling launcher terminates Node and its descendant', async () => {
  const child = spawn(launcher, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);"], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const started = await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('child startup timeout')), 5000).unref())]);
  const ids = JSON.parse(String(started[0]));
  child.kill();
  await once(child, 'close');
  for (let retry = 0; retry < 40; retry++) {
    if (ids.every(id => { try { process.kill(id, 0); return false; } catch (error) { return error.code === 'ESRCH'; } })) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('hook process survived launcher cancellation');
});
