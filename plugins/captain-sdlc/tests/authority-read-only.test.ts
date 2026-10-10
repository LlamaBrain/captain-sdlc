import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as authority from "../src/authority.js";

type Payload = { intentId: string; leaseToken: string; [key: string]: unknown };
type Revision = { schemaVersion: number; leaseId: string; revision: number; previousSha256?: string; state: "held" | "released"; payload: Payload };
type ReadOnlyApi = {
  readAuthorizedReadOnly<T>(root: string, bucket: string, id: string): Promise<T>;
  readAuthorizedLeaseStateReadOnly<T extends Payload>(root: string, id: string): Promise<{ state: "held" | "released"; payload: T } | undefined>;
};

function readers() {
  const api = authority as unknown as Partial<ReadOnlyApi>;
  assert.equal(typeof api.readAuthorizedReadOnly, "function", "strict read-only signed-envelope reader is missing");
  assert.equal(typeof api.readAuthorizedLeaseStateReadOnly, "function", "strict read-only lease reader is missing");
  return api as ReadOnlyApi;
}

const secret = Buffer.alloc(32, 0x53);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const payload: Payload = { intentId: "merge-own", leaseToken: "fixture-generation", sessionId: "session-own", ownerPid: 42 };

async function fixture(t: TestContext, withKey = true) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-authority-read-only-"));
  const root = path.join(container, "authority");
  t.after(async () => {
    assert.equal(path.dirname(container), path.resolve(tmpdir()));
    assert.ok(path.basename(container).startsWith("captain-authority-read-only-"));
    await rm(container, { recursive: true, force: true });
  });
  if (withKey) {
    await mkdir(root);
    await writeFile(path.join(root, "authority.key"), secret.toString("base64"));
  }
  return { container, root };
}

async function signed(root: string, bucket: string, id: string, value: unknown) {
  await mkdir(path.join(root, bucket), { recursive: true });
  const tag = createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
  await writeFile(path.join(root, bucket, id + ".json"), JSON.stringify({ payload: value, tag }));
}

function watermark(revision: Revision) {
  return { schemaVersion: 1, leaseId: revision.leaseId, revision: revision.revision, revisionSha256: digest(revision), ...(revision.previousSha256 ? { previousSha256: revision.previousSha256 } : {}) };
}

async function chain(root: string, states: Array<"held" | "released"> = ["held", "released", "held"]) {
  const revisions: Revision[] = [];
  for (const state of states) {
    const prior = revisions.at(-1);
    const current: Revision = { schemaVersion: 1, leaseId: "branch-own", revision: revisions.length, ...(prior ? { previousSha256: digest(prior) } : {}), state, payload };
    await signed(root, "lease-revisions", "branch-own-" + current.revision, current);
    await signed(root, "lease-watermarks", "branch-own-" + current.revision, watermark(current));
    revisions.push(current);
  }
  return revisions;
}

async function snapshot(root: string) {
  const entries: Array<{ path: string; kind: string; mtimeNs: string; ctimeNs: string; size: string; content?: string }> = [];
  async function visit(full: string, relative: string) {
    const stat = await lstat(full, { bigint: true });
    const entry = { path: relative, kind: stat.isDirectory() ? "directory" : "file", mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), size: String(stat.size) };
    if (stat.isDirectory()) {
      entries.push(entry);
      for (const name of (await readdir(full)).sort()) await visit(path.join(full, name), relative ? relative + "/" + name : name);
    } else entries.push({ ...entry, content: createHash("sha256").update(await readFile(full)).digest("hex") });
  }
  await visit(root, "");
  return entries;
}

async function unchanged<T>(container: string, action: () => Promise<T>) {
  // Pin directory timestamps before observation so even temp-file create/unlink
  // calls are visible if the final directory listing happens to be unchanged.
  async function pin(full: string) {
    const stat = await lstat(full);
    if (stat.isDirectory()) {
      for (const name of await readdir(full)) await pin(path.join(full, name));
      await utimes(full, new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    }
  }
  await pin(container);
  const before = await snapshot(container);
  try { return await action(); }
  finally { assert.deepEqual(await snapshot(container), before, "diagnosis changed authority bytes, paths or filesystem metadata"); }
}

test("read-only signed-envelope reader returns authenticated data without checkpoint writes", async t => {
  const api = readers(), f = await fixture(t), value = { merge_id: "merge-own", revision: 0, session_id: "session-own" };
  await signed(f.root, "merge-revisions", "merge-own-0", value);
  const actual = await unchanged(f.container, () => api.readAuthorizedReadOnly(f.root, "merge-revisions", "merge-own-0"));
  assert.deepEqual(actual, value);
});

for (const damage of ["payload", "tag"] as const) test("read-only signed-envelope reader rejects tampered " + damage + " without repair", async t => {
  const api = readers(), f = await fixture(t);
  await signed(f.root, "merge-revisions", "merge-own-0", { revision: 0 });
  const file = path.join(f.root, "merge-revisions", "merge-own-0.json"), envelope = JSON.parse(await readFile(file, "utf8"));
  if (damage === "payload") envelope.payload.revision = 1;
  else envelope.tag = "00".repeat(32);
  await writeFile(file, JSON.stringify(envelope));
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedReadOnly(f.root, "merge-revisions", "merge-own-0"), /authority tag/i));
});

test("read-only signed-envelope reader refuses a missing key without generating one", async t => {
  const api = readers(), f = await fixture(t);
  await signed(f.root, "merge-revisions", "merge-own-0", { revision: 0 });
  await unlink(path.join(f.root, "authority.key"));
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedReadOnly(f.root, "merge-revisions", "merge-own-0"), /ENOENT|key/i));
});

for (const damage of ["malformed suffix", "non-string tag"] as const) test("read-only signed-envelope reader rejects " + damage + " instead of accepting hex coercion", async t => {
  const api = readers(), f = await fixture(t);
  await signed(f.root, "merge-revisions", "merge-own-0", { revision: 0 });
  const file = path.join(f.root, "merge-revisions", "merge-own-0.json"), envelope = JSON.parse(await readFile(file, "utf8"));
  const validTag: string = envelope.tag;
  envelope.tag = damage === "malformed suffix" ? validTag + "not-hex" : [validTag];
  assert.deepEqual(Buffer.from(String(envelope.tag), "hex"), Buffer.from(validTag, "hex"), "regression must retain the old decoder's valid HMAC bytes");
  await writeFile(file, JSON.stringify(envelope));
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedReadOnly(f.root, "merge-revisions", "merge-own-0"), /authority tag/i));
});

test("read-only signed-envelope reader refuses a missing root without creating directories", async t => {
  const api = readers(), f = await fixture(t, false);
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedReadOnly(f.root, "merge-revisions", "merge-own-0"), /ENOENT|key/i));
});

test("read-only signed-envelope reader rejects a malformed existing key without replacing it", async t => {
  const api = readers(), f = await fixture(t);
  await signed(f.root, "merge-revisions", "merge-own-0", { revision: 0 });
  await writeFile(path.join(f.root, "authority.key"), "not-a-valid-authority-key");
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedReadOnly(f.root, "merge-revisions", "merge-own-0"), /key/i));
});

for (const released of [false, true]) test("read-only lease reader matches existing " + (released ? "released" : "held") + " state without writing checkpoints", async t => {
  const api = readers(), f = await fixture(t);
  // Create this positive control through the actual mutation helpers, rather
  // than accepting only records built by a parallel test implementation.
  await authority.acquireAuthorizedLease(f.root, "branch-own", payload);
  if (released) await authority.releaseAuthorizedLease(f.root, "branch-own", payload.intentId, payload.leaseToken);
  const actual = await unchanged(f.container, () => api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own"));
  assert.deepEqual(actual, { state: released ? "released" : "held", payload });
});

test("read-only lease reader reports no lease without creating absent buckets", async t => {
  const api = readers(), f = await fixture(t);
  assert.equal(await unchanged(f.container, () => api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own")), undefined);
});

test("read-only lease reader refuses a missing key/root rather than reporting unsigned absence", async t => {
  const api = readers(), f = await fixture(t, false);
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own"), /ENOENT|key/i));
});

test("read-only lease reader returns authenticated legacy ownership without migrating it", async t => {
  const api = readers(), f = await fixture(t);
  await signed(f.root, "leases", "branch-own", payload);
  assert.deepEqual(await unchanged(f.container, () => api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own")), { state: "held", payload });
});

test("read-only lease reader rejects unauthenticated legacy ownership without migration", async t => {
  const api = readers(), f = await fixture(t);
  await signed(f.root, "leases", "branch-own", payload);
  const file = path.join(f.root, "leases", "branch-own.json"), envelope = JSON.parse(await readFile(file, "utf8"));
  envelope.payload.intentId = "merge-foreign";
  await writeFile(file, JSON.stringify(envelope));
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own"), /authority tag/i));
});

test("read-only lease reader rejects a revision gap without filling it", async t => {
  const api = readers(), f = await fixture(t);
  await chain(f.root);
  await unlink(path.join(f.root, "lease-revisions", "branch-own-1.json"));
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own"), /contiguous|chain/i));
});

test("read-only lease reader rejects a signed revision with the wrong predecessor digest", async t => {
  const api = readers(), f = await fixture(t), revisions = await chain(f.root);
  const changed = { ...revisions[2], previousSha256: "00".repeat(32) };
  await signed(f.root, "lease-revisions", "branch-own-2", changed);
  await signed(f.root, "lease-watermarks", "branch-own-2", watermark(changed));
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own"), /chain|digest|hash/i));
});

test("read-only lease reader rejects a tampered revision signature without replacing it", async t => {
  const api = readers(), f = await fixture(t);
  await chain(f.root);
  const file = path.join(f.root, "lease-revisions", "branch-own-2.json"), envelope = JSON.parse(await readFile(file, "utf8"));
  envelope.tag = "00".repeat(32);
  await writeFile(file, JSON.stringify(envelope));
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own"), /authority tag/i));
});

for (const field of ["schemaVersion", "leaseId", "revision", "payload"] as const) test("read-only lease reader refuses a signed invalid revision " + field, async t => {
  const api = readers(), f = await fixture(t), revisions = await chain(f.root, ["held"]);
  const changed: Record<string, unknown> = { ...revisions[0] };
  changed[field] = field === "schemaVersion" ? 2 : field === "leaseId" ? "branch-foreign" : field === "revision" ? 9 : { intentId: "merge-own" };
  await signed(f.root, "lease-revisions", "branch-own-0", changed);
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own"), /chain|payload|binding|invalid/i));
});

for (const damage of ["missing", "signature", "schemaVersion", "leaseId", "revision", "revisionSha256", "previousSha256"] as const) test("read-only lease reader rejects " + damage + " watermark without synthesizing checkpoints", async t => {
  const api = readers(), f = await fixture(t), revisions = await chain(f.root);
  const id = "branch-own-2", file = path.join(f.root, "lease-watermarks", id + ".json");
  if (damage === "missing") await unlink(file);
  else if (damage === "signature") {
    const envelope = JSON.parse(await readFile(file, "utf8"));
    envelope.tag = "00".repeat(32);
    await writeFile(file, JSON.stringify(envelope));
  } else {
    const changed: Record<string, unknown> = { ...watermark(revisions[2]) };
    changed[damage] = damage === "schemaVersion" ? 2 : damage === "leaseId" ? "branch-foreign" : damage === "revision" ? 9 : "00".repeat(32);
    await signed(f.root, "lease-watermarks", id, changed);
  }
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own"), /watermark|checkpoint|authority tag|ENOENT/i));
});

test("read-only lease reader rejects a surviving future watermark after revision rollback", async t => {
  const api = readers(), f = await fixture(t);
  await chain(f.root);
  await unlink(path.join(f.root, "lease-revisions", "branch-own-2.json"));
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own"), /regressed|watermark|tail/i));
});

test("read-only lease reader rejects orphan watermarks without adopting a legacy lease", async t => {
  const api = readers(), f = await fixture(t);
  await signed(f.root, "leases", "branch-own", payload);
  await signed(f.root, "lease-watermarks", "branch-own-0", { schemaVersion: 1, leaseId: "branch-own", revision: 0, revisionSha256: "00".repeat(32) });
  await unchanged(f.container, () => assert.rejects(api.readAuthorizedLeaseStateReadOnly(f.root, "branch-own"), /regressed|watermark|tail/i));
});

test("existing mutating helpers still acquire, reject foreign release and reacquire generations", async t => {
  const f = await fixture(t), replacement = { ...payload, leaseToken: "replacement-generation" };
  await authority.acquireAuthorizedLease(f.root, "branch-own", payload);
  await assert.rejects(authority.releaseAuthorizedLease(f.root, "branch-own", "merge-foreign", payload.leaseToken), /owner mismatch|generation/i);
  assert.deepEqual(await authority.readAuthorizedLeaseState(f.root, "branch-own"), { state: "held", payload });
  await authority.releaseAuthorizedLease(f.root, "branch-own", payload.intentId, payload.leaseToken);
  await authority.acquireAuthorizedLease(f.root, "branch-own", replacement);
  assert.deepEqual(await authority.readAuthorizedLeaseState(f.root, "branch-own"), { state: "held", payload: replacement });
});
