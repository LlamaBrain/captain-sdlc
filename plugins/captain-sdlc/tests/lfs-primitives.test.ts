import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { formatLfsPointer, hashLfsFile, hydrateLfsObject, parseLfsPointer, persistLfsObject, verifyLfsObject } from "../src/lfs.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function folder(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-lfs-primitives-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-lfs-primitives-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
const content = Buffer.from(Array.from({ length: 4099 }, (_, i) => (i * 37 + 9) % 256));
const pointer = { oid: hash(content), size: content.length };
const text = `version https://git-lfs.github.com/spec/v1\noid sha256:${pointer.oid}\nsize ${pointer.size}\n`;

test("parse canonical and legacy LFS pointers and distinguish normal blobs", () => {
  assert.deepEqual(parseLfsPointer(Buffer.from(text)), pointer);
  assert.deepEqual(parseLfsPointer(Buffer.from(text.replace("https://git-lfs.github.com/spec/v1", "https://hawser.github.com/spec/v1"))), pointer);
  assert.deepEqual(parseLfsPointer(Buffer.from(text.replace("https://git-lfs.github.com/spec/v1", "http://git-media.io/v/2"))), pointer);
  assert.equal(parseLfsPointer(content), null);
  assert.equal(parseLfsPointer(Buffer.from("version 1.2 is ordinary text\n")), null);
  assert.equal(parseLfsPointer(Buffer.alloc(0)), null, "Git LFS passes an empty blob through unchanged");
  assert.deepEqual(formatLfsPointer(pointer), Buffer.from(text));
  assert.deepEqual(formatLfsPointer({ oid: hash(Buffer.alloc(0)), size: 0 }), Buffer.alloc(0));
});

test("malformed, ambiguous, and extension-bearing pointers fail closed", () => {
  for (const invalid of [
    text.replace("https://git-lfs.github.com/spec/v1", "https://example.invalid/v1"),
    text.replace(pointer.oid, "z".repeat(64)),
    text.replace(pointer.oid, pointer.oid.toUpperCase()),
    text.replace(`size ${pointer.size}`, "size -1"),
    text.replace(`size ${pointer.size}`, "size 9007199254740992"),
    text.replace("\noid", "\next-0-exec sha256:" + "a".repeat(64) + "\noid"),
    text + "size 1\n",
    text.slice(0, -1),
    text.replace(/\n/g, "\r\n"),
    text + "x".repeat(1024)
  ]) assert.throws(() => parseLfsPointer(Buffer.from(invalid)), /lfs|pointer|format|size|extension|version/i);
});

test("file hashing streams real content and handles an empty file", async t => {
  const root = await folder(t), source = path.join(root, "large.bin"), empty = path.join(root, "empty.bin");
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 73, 0xa5);
  bytes[bytes.length - 1] = 1;
  await writeFile(source, bytes);
  await writeFile(empty, Buffer.alloc(0));
  assert.deepEqual(await hashLfsFile(source), { oid: hash(bytes), size: bytes.length });
  assert.deepEqual(await hashLfsFile(empty), { oid: hash(Buffer.alloc(0)), size: 0 });
});

test("object storage persists, deduplicates and verifies real bytes", async t => {
  const root = await folder(t), objects = path.join(root, "lfs", "objects"), source = path.join(root, "asset.bin");
  await writeFile(source, content);
  assert.deepEqual(await persistLfsObject(objects, source), pointer);
  assert.deepEqual(await persistLfsObject(objects, source), pointer);
  await verifyLfsObject(objects, pointer);
  const object = path.join(objects, pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
  assert.deepEqual(await readFile(object), content);
  await writeFile(object, Buffer.alloc(content.length, 42));
  await assert.rejects(verifyLfsObject(objects, pointer), /lfs|object|integrity|hash|digest|checksum/i);
  await assert.rejects(persistLfsObject(objects, source), /lfs|object|integrity|hash|digest|checksum/i);
});

test("hydration replaces only the expected pointer and leaves it intact on corruption", async t => {
  const root = await folder(t), objects = path.join(root, "lfs", "objects"), source = path.join(root, "asset.bin"), destination = path.join(root, "checkout.bin");
  await writeFile(source, content);
  await persistLfsObject(objects, source);
  await writeFile(destination, Buffer.from(text));
  await hydrateLfsObject(objects, pointer, destination);
  assert.deepEqual(await readFile(destination), content);
  await writeFile(destination, Buffer.from(text));
  const object = path.join(objects, pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
  await writeFile(object, Buffer.alloc(content.length, 42));
  await assert.rejects(hydrateLfsObject(objects, pointer, destination), /lfs|object|integrity|hash|digest|checksum/i);
  assert.deepEqual(await readFile(destination), Buffer.from(text));
  await writeFile(destination, "unrelated changed file");
  await assert.rejects(hydrateLfsObject(objects, pointer, destination), /lfs|pointer|destination|changed/i);
  assert.equal(await readFile(destination, "utf8"), "unrelated changed file");
});

test("LFS object paths never traverse a directory symlink or junction", async t => {
  const root = await folder(t), source = path.join(root, "asset.bin"), outside = path.join(root, "outside"), link = path.join(root, "linked");
  await writeFile(source, content);
  await mkdir(outside);
  try { await symlink(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error: any) { if (error.code === "EPERM" || error.code === "EACCES") { t.skip("directory links are unavailable to this test account"); return; } throw error; }
  await assert.rejects(persistLfsObject(path.join(link, "objects"), source), /symlink|link|reparse|outside/i);
  await assert.rejects(verifyLfsObject(path.join(link, "objects"), pointer), /symlink|link|reparse|outside/i);
});

test("concurrent persistence of one object leaves verified content", async t => {
  const root = await folder(t), source = path.join(root, "asset.bin");
  await writeFile(source, content);
  for (let round = 0; round < 8; round++) {
    const objects = path.join(root, `objects-${round}`);
    const results = await Promise.all([persistLfsObject(objects, source), persistLfsObject(objects, source), persistLfsObject(objects, source)]);
    assert.deepEqual(results, [pointer, pointer, pointer]);
    await verifyLfsObject(objects, pointer);
  }
});
