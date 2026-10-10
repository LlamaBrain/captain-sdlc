import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as authority from "../src/authority.js";

const payload = { intentId: "intent-fixture", leaseToken: "fixture-generation-token", targetBranch: "fixture", targetOid: "a".repeat(40) };
const generation = (leaseId: string, revision: number, value = payload) => createHash("sha256").update(JSON.stringify({ leaseId, revision, state: "held", payload: value })).digest("hex");
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
      else result[name] = createHash("sha256").update(await readFile(path.join(directory, entry.name))).digest("hex");
    }
  }
  await visit(root); return result;
}
async function fixture(body: (root: string, id: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "captain-generation-cas-"));
  try { await authority.acquireAuthorizedLease(root, "fixture_lease", payload); await body(root, "fixture_lease"); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("exact generation release publishes one release and repeats without mutation", async () => {
  assert.equal(typeof authority.releaseAuthorizedLeaseAtGeneration, "function", "missing exact generation CAS release");
  await fixture(async (root, id) => {
    await authority.releaseAuthorizedLeaseAtGeneration(root, id, payload.intentId, payload.leaseToken, 0, generation(id, 0));
    assert.equal((await authority.readAuthorizedLeaseSnapshotReadOnly(root, id))?.state, "released");
    const after = await snapshot(root);
    await authority.releaseAuthorizedLeaseAtGeneration(root, id, payload.intentId, payload.leaseToken, 0, generation(id, 0));
    assert.deepEqual(await snapshot(root), after);
  });
});

test("stale ABA generation with the same owner and token stays held", async () => {
  assert.equal(typeof authority.releaseAuthorizedLeaseAtGeneration, "function");
  await fixture(async (root, id) => {
    await authority.releaseAuthorizedLease(root, id, payload.intentId, payload.leaseToken);
    await authority.acquireAuthorizedLease(root, id, payload);
    const before = await snapshot(root);
    await assert.rejects(authority.releaseAuthorizedLeaseAtGeneration(root, id, payload.intentId, payload.leaseToken, 0, generation(id, 0)), /generation changed/);
    assert.deepEqual(await snapshot(root), before);
    assert.equal((await authority.readAuthorizedLeaseSnapshotReadOnly(root, id))?.revision, 2);
  });
});

test("foreign owner and mismatched opaque generation refuse without mutation", async () => {
  assert.equal(typeof authority.releaseAuthorizedLeaseAtGeneration, "function");
  await fixture(async (root, id) => {
    const before = await snapshot(root);
    await assert.rejects(authority.releaseAuthorizedLeaseAtGeneration(root, id, "foreign-intent", payload.leaseToken, 0, generation(id, 0)), /owner mismatch/);
    await assert.rejects(authority.releaseAuthorizedLeaseAtGeneration(root, id, payload.intentId, payload.leaseToken, 0, "f".repeat(64)), /generation changed/);
    assert.deepEqual(await snapshot(root), before);
  });
});

test("replaying an old release never releases a replacement owner", async () => {
  assert.equal(typeof authority.releaseAuthorizedLeaseAtGeneration, "function");
  await fixture(async (root, id) => {
    await authority.releaseAuthorizedLeaseAtGeneration(root, id, payload.intentId, payload.leaseToken, 0, generation(id, 0));
    await authority.acquireAuthorizedLease(root, id, { ...payload, intentId: "replacement-intent", leaseToken: "replacement-token" });
    const before = await snapshot(root);
    await assert.rejects(authority.releaseAuthorizedLeaseAtGeneration(root, id, payload.intentId, payload.leaseToken, 0, generation(id, 0)), /owner mismatch/);
    assert.deepEqual(await snapshot(root), before);
  });
});
