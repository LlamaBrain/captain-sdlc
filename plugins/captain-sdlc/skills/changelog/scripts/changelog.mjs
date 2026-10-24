#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const categories = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const marker = '<!-- captain-changes:v1 -->';
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const git = async (repo, ...args) => (await exec('git', args, { cwd: repo, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout.trimEnd();
const hash = value => createHash('sha256').update(value).digest('hex');
const textLine = value => value.replace(/\s+/g, ' ').trim();
function requireText(value, name) { if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error(`${name} must be nonempty single-line text`); return value; }
function date(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('date must be a real ISO YYYY-MM-DD date'); return value; }

function conventional(message) {
  if (typeof message !== 'string' || message.startsWith('\uFEFF') || message.includes('\0')) throw new Error('invalid Conventional Commit message');
  const lines = message.replaceAll('\r\n', '\n').split('\n');
  const match = /^([a-z][a-z0-9-]*)(?:\(([^()\r\n]+)\))?(!)?: (\S[^\r\n]*)$/i.exec(lines[0]);
  if (!match || (lines.length > 1 && lines[1].trim())) throw new Error(`invalid Conventional Commit: ${lines[0]}`);
  const type = match[1].toLowerCase(), scope = match[2] ?? null, description = match[4].trim();
  const footers = new Map();
  let current;
  for (let i = 2; i < lines.length; i++) {
    const footer = /^(BREAKING CHANGE|BREAKING-CHANGE|[A-Za-z][A-Za-z0-9-]*)(: | #)(.*)$/.exec(lines[i]);
    if (footer && (current || !lines[i - 1].trim())) {
      const key = ['BREAKING CHANGE', 'BREAKING-CHANGE'].includes(footer[1]) ? 'BREAKING CHANGE' : footer[1].toLowerCase();
      if (key === 'BREAKING CHANGE' && footer[2] !== ': ') throw new Error('BREAKING CHANGE requires colon-space separator');
      if (footers.has(key) && key.startsWith('changelog-')) throw new Error(`duplicate Conventional Commit footer: ${key}`);
      current = key; footers.set(key, (footers.has(key) ? footers.get(key) + '\n' : '') + footer[3]);
    } else if (current) footers.set(current, footers.get(current) + '\n' + lines[i]);
  }
  const migration = textLine(footers.get('BREAKING CHANGE') ?? footers.get('BREAKING-CHANGE') ?? '');
  if ((footers.has('BREAKING CHANGE') || footers.has('BREAKING-CHANGE')) && !migration) throw new Error('BREAKING CHANGE requires a description');
  const breaking = !!match[3] || !!migration;
  const category = footers.has('changelog-category') ? textLine(footers.get('changelog-category')) : type === 'feat' ? 'Added' : type === 'fix' ? 'Fixed' : 'Changed';
  if (!categories.includes(category)) throw new Error(`invalid changelog category: ${category}`);
  const excluded = textLine(footers.get('changelog-exclude') ?? 'false');
  if (!['true', 'false'].includes(excluded)) throw new Error('Changelog-Exclude must be true or false');
  return { type, scope, description, breaking, migration: breaking ? migration || description : null, category, summary: textLine(footers.get('changelog-note') ?? description.replace(/ \(v\d+\.\d+\.\d+\)$/, '')), excluded: excluded === 'true' };
}

function semver(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value ?? '');
  if (!match) throw new Error(`invalid SemVer: ${value}`);
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? [] };
}
function compareCore(a, b) { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; return 0; }
function compareVersion(a, b) {
  const core = compareCore(a.core, b.core); if (core) return core;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] === b.pre[i] ? 0 : a.pre[i] === undefined ? -1 : 1;
    const x = a.pre[i], y = b.pre[i]; if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    return xn && yn ? BigInt(x) > BigInt(y) ? 1 : -1 : xn !== yn ? xn ? -1 : 1 : x > y ? 1 : -1;
  }
  return 0;
}
function bump(entries, maintenance = 'none') {
  if (!['none', 'patch'].includes(maintenance)) throw new Error('maintenance-bump must be none or patch');
  // Exclusion controls presentation only: it never conceals compatibility/version impact.
  return entries.some(e => e.breaking) ? 'major' : entries.some(e => e.type === 'feat') ? 'minor' : entries.some(e => e.type === 'fix') ? 'patch' : entries.length ? maintenance : 'none';
}
function section(entries) {
  const blocks = [];
  for (const category of categories) {
    const selected = entries.filter(e => !e.excluded && e.category === category);
    if (!selected.length) continue;
    blocks.push(`### ${category}\n\n` + selected.map(e => `- ${e.scope ? `**${e.scope}:** ` : ''}${e.summary} (${e.oid})${e.breaking ? `\n  - **Breaking change:** ${e.migration}` : ''}`).join('\n'));
  }
  return blocks.join('\n\n');
}
function render(data) {
  return `# ${data.subject}\n\nDeveloper-facing changes for \`${data.project}\`.\n\nTask: \`${data.id}\`\nSource: \`${data.source_branch}\` at \`${data.source_head}\`\nTarget: \`${data.target_head}\`\nMerge base: \`${data.merge_base}\`\n\n${section(data.entries) || 'No developer-facing entries.'}\n\n${marker}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
}
function validate(data) {
  if (!data || data.schema_version !== 1 || data.audience !== 'developer') throw new Error('unsupported developer changes artifact');
  for (const key of ['project', 'id', 'subject', 'source_branch']) requireText(data[key], key);
  for (const key of ['source_head', 'target_head', 'merge_base']) if (!oidPattern.test(data[key])) throw new Error(`invalid provenance OID: ${key}`);
  if (!Array.isArray(data.entries) || !Array.isArray(data.omitted)) throw new Error('invalid artifact entries or omitted provenance');
  const seen = new Set();
  for (const entry of data.entries) {
    if (!entry || !oidPattern.test(entry.oid) || seen.has(entry.oid)) throw new Error('invalid or duplicate entry OID'); seen.add(entry.oid);
    const parsed = conventional(entry.message);
    for (const key of ['type', 'scope', 'description', 'breaking', 'migration', 'excluded']) if (entry[key] !== parsed[key]) throw new Error(`Conventional Commit provenance mismatch: ${key}`);
    if (!categories.includes(entry.category)) throw new Error('invalid changelog category');
    requireText(entry.summary, 'summary');
  }
  for (const entry of data.omitted) if (!entry || !oidPattern.test(entry.oid) || seen.has(entry.oid) || !['structural-merge', 'artifact-only'].includes(entry.reason)) throw new Error('invalid omitted provenance OID'); else seen.add(entry.oid);
  return data;
}
async function readArtifact(file, canonical = true) {
  const raw = await readFile(file, 'utf8');
  const content = raw.replaceAll('\r\n', '\n');
  const matches = [...content.matchAll(/<!-- captain-changes:v1 -->\n```json\n([\s\S]*?)\n```/g)];
  if (matches.length !== 1) throw new Error(`not a changes artifact; refusing overwrite: ${file}`);
  const data = validate(JSON.parse(matches[0][1]));
  if (canonical && render(data) !== content) throw new Error(`artifact rendering/metadata drift: ${file}; run render after curation`);
  return { data, content, raw };
}
async function ensureSafePath(repo, output) {
  const relative = path.relative(repo, output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('output is outside the repository');
  for (let cursor = output; cursor !== repo; cursor = path.dirname(cursor)) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('output crosses a symlink or reparse point'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function repoRoot(input) {
  const repo = await realpath(path.resolve(requireText(input, 'repo')));
  const root = await realpath(await git(repo, 'rev-parse', '--show-toplevel'));
  if (root.toLowerCase() !== repo.toLowerCase()) throw new Error('repo must name the exact worktree root');
  return root;
}
async function history(repo, source, target) {
  const commits = (await git(repo, 'rev-list', '--reverse', '--topo-order', source, '--not', target)).split('\n').filter(Boolean);
  const entries = [], omitted = [];
  for (const oid of commits) {
    const message = await git(repo, 'show', '-s', '--format=%B', oid);
    const parents = (await git(repo, 'show', '-s', '--format=%P', oid)).split(' ').filter(Boolean);
    if (parents.length > 1 && !/^[a-z][a-z0-9-]*(?:\([^()]+\))?!?: /i.test(message.split('\n')[0])) { omitted.push({ oid, reason: 'structural-merge' }); continue; }
    const files = (await git(repo, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', oid)).split('\0').filter(Boolean);
    if (files.length && files.every(file => file === 'changes.md' || file.startsWith('changelog/changes/'))) { omitted.push({ oid, reason: 'artifact-only' }); continue; }
    entries.push({ oid, message, ...conventional(message) });
  }
  return { entries, omitted };
}
async function verifyGit(repo, data) {
  if (await git(repo, 'merge-base', data.source_head, data.target_head) !== data.merge_base) throw new Error('Git provenance mismatch: merge base');
  const expected = await history(repo, data.source_head, data.target_head);
  if (JSON.stringify(expected.omitted) !== JSON.stringify(data.omitted) || expected.entries.length !== data.entries.length) throw new Error('Git provenance mismatch: incomplete commit coverage');
  for (let i = 0; i < expected.entries.length; i++) {
    const { summary: _summary, category: _category, ...raw } = expected.entries[i];
    const { summary: _curatedSummary, category: _curatedCategory, ...actual } = data.entries[i];
    if (JSON.stringify(raw) !== JSON.stringify(actual)) throw new Error('Git provenance mismatch: commit coverage or message');
  }
}
async function collect(options) {
  const repo = await repoRoot(options.repo), project = requireText(options.project, 'project'), id = requireText(options.id, 'id'), subject = requireText(options.subject, 'subject');
  requireText(options.target, 'target');
  const source = await git(repo, 'rev-parse', 'HEAD'), target = await git(repo, 'rev-parse', '--verify', '--end-of-options', `${options.target}^{commit}`);
  const branch = await git(repo, 'symbolic-ref', '--short', 'HEAD');
  const mergeBase = await git(repo, 'merge-base', source, target);
  const dirty = (await git(repo, 'diff', '--name-only', '-z', 'HEAD')).split('\0').filter(Boolean);
  const untracked = (await git(repo, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  if ([...dirty, ...untracked].some(file => file !== 'changes.md' && !file.startsWith('changelog/changes/'))) throw new Error('commit task source before collection; uncommitted files would be omitted');
  const { entries, omitted } = await history(repo, source, target);
  const output = path.join(repo, 'changes.md'); await ensureSafePath(repo, output);
  try {
    const previous = (await readArtifact(output)).data;
    if (previous.project !== project || previous.id !== id || previous.source_branch !== branch) throw new Error('refusing to overwrite a foreign task artifact');
    const current = new Map(entries.map(e => [e.oid, e]));
    for (const old of previous.entries) {
      const entry = current.get(old.oid); if (!entry || old.message !== entry.message) throw new Error('draft refresh would erase prior curation/provenance');
      entry.summary = old.summary; entry.category = old.category;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const data = validate({ schema_version: 1, audience: 'developer', project, id, subject, source_branch: branch, source_head: source, target_head: target, merge_base: mergeBase, entries, omitted });
  if (await git(repo, 'rev-parse', 'HEAD') !== source || await git(repo, 'rev-parse', '--verify', '--end-of-options', `${options.target}^{commit}`) !== target) throw new Error('source/target moved during collection');
  await writeFile(output, render(data));
  return JSON.stringify({ path: output, source_head: source, target_head: target, entries: entries.length, recommended_bump: bump(entries) });
}
async function archive(options) {
  const repo = await repoRoot(options.repo), input = path.resolve(requireText(options.input, 'input'));
  const { data, raw: content } = await readArtifact(input); const day = date(options.date);
  if ((await lstat(input)).isSymbolicLink()) throw new Error('refusing symlink draft');
  if (await git(repo, 'rev-parse', 'HEAD') !== data.source_head || await git(repo, 'symbolic-ref', '--short', 'HEAD') !== data.source_branch) throw new Error('draft source changed; refresh changes.md before archive');
  await verifyGit(repo, data);
  const slug = data.subject.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 80).replace(/-$/, '') || 'changes';
  const output = path.join(repo, 'changelog', 'changes', `${day}-${slug}-${hash(data.project + '\0' + data.id).slice(0, 12)}.md`);
  await ensureSafePath(repo, output);
  if (options['retire-draft'] && input !== path.join(repo, 'changes.md')) throw new Error('retire-draft may remove only this worktree changes.md');
  await mkdir(path.dirname(output), { recursive: true });
  try { await writeFile(output, content, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; if (await readFile(output, 'utf8') !== content) throw new Error(`archive collision: ${output}`); }
  if (options['retire-draft']) { if (await readFile(input, 'utf8') !== content) throw new Error('draft changed during archive'); await unlink(input); }
  return JSON.stringify({ path: output, id: data.id, source_head: data.source_head, sha256: hash(content) });
}
async function compose(options) {
  if (!options.input?.length) throw new Error('compose requires one or more --input artifacts');
  const fragments = await Promise.all([...options.input, ...(options['exclude-input'] ?? [])].map(file => readArtifact(file)));
  const project = fragments[0].data.project;
  if (fragments.some(f => f.data.project !== project)) throw new Error('cannot compose different project identities');
  const excluded = new Set(fragments.slice(options.input.length).flatMap(f => f.data.entries.map(e => e.oid)));
  const entries = new Map();
  for (const { data } of fragments.slice(0, options.input.length)) for (const entry of data.entries) {
    const old = entries.get(entry.oid);
    if (old && JSON.stringify(old) !== JSON.stringify(entry)) throw new Error(`conflicting curation or provenance for ${entry.oid}`);
    entries.set(entry.oid, entry);
  }
  if (options.repo) {
    const repo = await repoRoot(options.repo);
    for (const { data } of fragments) await verifyGit(repo, data);
  }
  const selected = [...entries.values()].filter(e => !excluded.has(e.oid)).sort((a, b) => a.oid.localeCompare(b.oid));
  const recommended = bump(selected, options['maintenance-bump']);
  let heading = '## [Unreleased]';
  if (options.version || options.date || options['base-version']) {
    if (!options.version || !options.date || !options['base-version']) throw new Error('release composition requires version, date and base-version together');
    const base = semver(options['base-version']), next = semver(options.version); date(options.date);
    const floor = [...base.core];
    if (recommended === 'major') { floor[0]++; floor[1] = 0n; floor[2] = 0n; }
    if (recommended === 'minor') { floor[1]++; floor[2] = 0n; }
    if (recommended === 'patch') floor[2]++;
    if (compareVersion(next, base) <= 0 || compareCore(next.core, floor) < 0) throw new Error(`release does not satisfy ${recommended} SemVer impact from ${options['base-version']}`);
    heading = `## [${options.version}] - ${options.date}`;
  }
  const output = `${heading}\n\n<!-- Developer changelog; project: ${project}; Recommended bump: ${recommended}; Git provenance ${options.repo ? 'verified' : 'not checked (offline artifacts)'}. -->\n\n${section(selected) || 'No developer-facing entries.'}\n`;
  if (options.output) await writeFile(path.resolve(options.output), output, { flag: 'wx' });
  return output;
}

function args(argv) {
  const command = argv.shift(); const options = {};
  const allowed = { collect: ['repo', 'target', 'project', 'id', 'subject'], archive: ['repo', 'input', 'date', 'retire-draft'], compose: ['repo', 'input', 'exclude-input', 'maintenance-bump', 'base-version', 'version', 'date', 'output'], render: ['input', 'write'] };
  if (!allowed[command]) throw new Error('use collect, archive, compose or render');
  while (argv.length) {
    const token = argv.shift(); if (!token.startsWith('--') || !allowed[command].includes(token.slice(2))) throw new Error(`unknown argument: ${token}`);
    const key = token.slice(2), repeat = command === 'compose' && ['input', 'exclude-input'].includes(key);
    if (!repeat && Object.hasOwn(options, key)) throw new Error(`duplicate argument: ${token}`);
    const flag = ['write', 'retire-draft'].includes(key);
    const value = flag ? true : argv.shift(); if (!flag && (!value || value.startsWith('--'))) throw new Error(`missing value for ${token}`);
    if (repeat) (options[key] ??= []).push(value); else options[key] = value;
  }
  return { command, options };
}
async function main() {
  const { command, options } = args(process.argv.slice(2));
  if (command === 'collect') return collect(options);
  if (command === 'archive') return archive(options);
  if (command === 'compose') return compose(options);
  const { data } = await readArtifact(requireText(options.input, 'input'), false); const output = render(data);
  if (options.write) { if ((await lstat(options.input)).isSymbolicLink()) throw new Error('refusing symlink write'); await writeFile(options.input, output); }
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(output => process.stdout.write(output.trimEnd() + '\n')).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
