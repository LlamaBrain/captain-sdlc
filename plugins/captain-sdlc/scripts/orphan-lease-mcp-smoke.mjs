import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
const fixture = await mkdtemp(path.join(tmpdir(), 'captain-orphan-mcp-'));
const target = path.join(fixture, 'retained target with spaces'), source = path.join(fixture, 'retained source with spaces');
const dataRoot = path.join(fixture, 'isolated authority');
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', ['--no-optional-locks', ...args], { cwd, windowsHide: true })).stdout.trim();
const sha = data => createHash('sha256').update(data).digest('hex');
async function tree(root) {
  const result = {};
  async function walk(directory, relative = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else result[name] = sha(await readFile(path.join(directory, entry.name)));
    }
  }
  await walk(root); return result;
}
await mkdir(path.join(target, '.captain-sdlc/notebook'), { recursive: true });
await git(target, 'init', '-b', 'main'); await git(target, 'config', 'core.autocrlf', 'false');
await git(target, 'config', 'user.name', 'Captain Fixture'); await git(target, 'config', 'user.email', 'captain@example.invalid');
await writeFile(path.join(target, '.gitignore'), 'Temp/\n');
await writeFile(path.join(target, 'VERSION'), '1.0.0\n'); await writeFile(path.join(target, 'CHANGELOG.md'), 'baseline\n');
await writeFile(path.join(target, 'product.txt'), 'base\n');
await writeFile(path.join(target, '.captain-sdlc/notebook/notes.json'), '{}\n');
await writeFile(path.join(target, '.captain-sdlc/captain.ignore'), '/.captain-sdlc/notebook/notes.json\n');
await writeFile(path.join(target, '.captain-sdlc/codex-policy.json'), JSON.stringify({ profile: 'low', visualRequired: false,
  commands: { build: 'node gate.cjs', ticket: 'node gate.cjs', 'feature-smoke': 'node gate.cjs', 'affected-regression': 'node gate.cjs' }, sourceManifestExcludes: ['Temp'],
  commit: { conventional: true, require_version_suffix: false, require_task_trailer: true, version_file: 'VERSION', version_surfaces: [],
    changelog_files: ['CHANGELOG.md'], bookkeeping: { path_file: '.captain-sdlc/captain.ignore' } } }));
await writeFile(path.join(target, '.captain-sdlc/merge-policy.json'), JSON.stringify({ schema_version: 1, strictness: 'low' }));
await writeFile(path.join(target, 'gate.cjs'), "const fs=require('node:fs');fs.mkdirSync('Temp',{recursive:true});fs.writeFileSync('Temp/build-count','1');console.log('passed');\n");
await git(target, 'add', '.'); await git(target, 'commit', '-m', 'fixture baseline');
await git(target, 'worktree', 'add', '-b', 'retained-task', source);
await writeFile(path.join(source, 'product.txt'), 'implemented\n'); await git(source, 'commit', '-am', 'fixture product');
const commonGitDir = path.resolve(await git(target, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
const leaseId = sha(`${commonGitDir}\0refs/heads/main`.toLowerCase());
const { writeAuthorized } = await import(pathToFileURL(path.join(root, 'dist/authority.js')));
await writeAuthorized(dataRoot, 'leases', leaseId, { intentId: 'intent-public-orphan', leaseToken: 'fixture-private-token',
  commonGitDir, targetBranch: 'main', targetOid: await git(target, 'rev-parse', 'HEAD') });
const notePath = '.captain-sdlc/notebook/notes.json';
await writeFile(path.join(target, notePath), '{"retained":true}\n');
const before = await tree(target), beforeSource = await tree(source), registry = await git(target, 'worktree', 'list', '--porcelain');
const client = new Client({ name: 'captain-orphan-lease-smoke', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/server.js')], cwd: root,
  env: { ...process.env, CAPTAIN_PLUGIN_DATA: dataRoot, CODEX_PLUGIN_ROOT: root, PLUGIN_ROOT: root }, stderr: 'pipe' });
async function call(name, args, expectError = false) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  if (expectError) { assert.equal(response.isError, true); return response; }
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
}
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('captain_branch_lease_diagnose')); assert.ok(names.includes('captain_repossess_branch_lease'));
  const args = { project_root: target, target_worktree: target, target_branch: 'main', session_id: 'public-smoke' };
  const authorityBefore = await tree(dataRoot), diagnosis = await call('captain_branch_lease_diagnose', args);
  assert.equal(diagnosis.eligible, true); assert.deepEqual(await tree(dataRoot), authorityBefore);
  assert.doesNotMatch(JSON.stringify(diagnosis), /fixture-private-token|leaseToken/);
  const request = { ...diagnosis.recovery.args, reason: 'Recover this isolated orphan reservation',
    user_authorization: 'Unblock it. Use repossession and retain the same worktree.' };
  await call('captain_repossess_branch_lease', { ...request, resource_generation: 'f'.repeat(64) }, true);
  assert.deepEqual(await tree(dataRoot), authorityBefore);
  const receipt = await call('captain_repossess_branch_lease', request);
  assert.equal(receipt.state, 'released'); assert.doesNotMatch(JSON.stringify(receipt), /fixture-private-token|leaseToken/);
  assert.deepEqual(await tree(target), before); assert.deepEqual(await tree(source), beforeSource);
  assert.deepEqual(await call('captain_repossess_branch_lease', request), receipt);
  const prep = await call('captain_merge_prep', { source_worktree: source, target_worktree: target, target_branch: 'main', session_id: 'public-smoke',
    finalization: { target: { paths: [notePath], task_id: 'public-smoke-records', subject: 'docs(captain): park retained records', disposition: 'stash' } } });
  assert.equal(prep.state, 'ready'); assert.equal(prep.source_worktree, source); assert.equal(prep.target_worktree, target);
  assert.equal(await git(target, 'worktree', 'list', '--porcelain'), registry);
  const parked = prep.finalizations.find(item => item.state === 'stashed'); assert.ok(parked?.stash_oid);
  assert.equal(await git(target, 'show', `${parked.stash_oid}:${notePath}`), '{"retained":true}');
  assert.equal(await git(target, 'status', '--porcelain'), '');
  const proofPath = path.join(root, '.captain-proof/smoke.json'), proof = JSON.parse(await readFile(proofPath, 'utf8'));
  proof.orphan_lease = { status: 'green', created_at: new Date().toISOString(), server_sha256: sha(await readFile(path.join(root, 'dist/server.js'))), fixture,
    outcomes: ['read-only authenticated legacy diagnosis', 'stale generation refused without mutation', 'signed exact release preserves both checkouts',
      'idempotent recovery and ordinary Prep acquire fresh lease in same worktrees', 'target records retained in exact correlated stash'] };
  await writeFile(proofPath, JSON.stringify(proof, null, 2) + '\n'); console.log(JSON.stringify(proof.orphan_lease));
} finally { await client.close(); }
