import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const fixedId = "d49b8bb9-642c-454e-8a44-e5d3ea908c1c";
crypto.randomUUID = (() => fixedId) as typeof crypto.randomUUID;
syncBuiltinESMExports();
const { formatLfsPointer, hashLfsFile, hydrateLfsObject, persistLfsObject } = await import("../src/lfs.js");

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-lfs-temp-owner-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-lfs-temp-owner-"));
    await rm(root, { recursive: true, force: true });
  });
  const objects = path.join(root, "objects"), source = path.join(root, "asset.bin");
  await mkdir(objects); await writeFile(source, "fixture content\n");
  return { root, objects, source };
}

test("LFS persistence never removes a pre-existing temporary file", async t => {
  const f = await fixture(t), collision = path.join(f.objects, `.captain-lfs-${fixedId}.tmp`);
  await writeFile(collision, "foreign data\n");
  await assert.rejects(persistLfsObject(f.objects, f.source), { code: "EEXIST" });
  assert.equal(await readFile(collision, "utf8"), "foreign data\n");
});

test("LFS hydration never removes a pre-existing temporary file", async t => {
  const f = await fixture(t), pointer = await persistLfsObject(f.objects, f.source);
  const destination = path.join(f.root, "destination"), collision = path.join(f.root, `.captain-lfs-${fixedId}.tmp`);
  await writeFile(destination, formatLfsPointer(pointer)); await writeFile(collision, "foreign data\n");
  await assert.rejects(hydrateLfsObject(f.objects, pointer, destination), { code: "EEXIST" });
  assert.equal(await readFile(collision, "utf8"), "foreign data\n");
  assert.deepEqual(await readFile(destination), formatLfsPointer(pointer));
});

for (const operation of ["persist", "hydrate"] as const) {
  test(`LFS ${operation} refuses a replaced temporary file without removing it`, async t => {
    const f = await fixture(t);
    const pointer = operation === "hydrate" ? await persistLfsObject(f.objects, f.source) : undefined;
    const destination = path.join(f.root, "destination");
    if (pointer) await writeFile(destination, formatLfsPointer(pointer));
    const temp = path.join(operation === "persist" ? f.objects : f.root, `.captain-lfs-${fixedId}.tmp`);
    const nativeOpen = fs.promises.open;
    fs.promises.open = (async (...args: Parameters<typeof nativeOpen>) => {
      const handle = await nativeOpen(...args);
      if (String(args[0]) === temp) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); await rename(temp, `${temp}.owned`); await writeFile(temp, "foreign replacement\n"); };
      }
      return handle;
    }) as typeof nativeOpen;
    syncBuiltinESMExports();
    try {
      await assert.rejects(operation === "persist" ? persistLfsObject(f.objects, f.source) : hydrateLfsObject(f.objects, pointer!, destination));
      assert.equal(await readFile(temp, "utf8"), "foreign replacement\n");
      if (pointer) assert.deepEqual(await readFile(destination), formatLfsPointer(pointer));
    } finally { fs.promises.open = nativeOpen; syncBuiltinESMExports(); }
  });

  test(`LFS ${operation} refuses modified temporary content before publication`, async t => {
    const f = await fixture(t), expected = await hashLfsFile(f.source);
    const pointer = operation === "hydrate" ? await persistLfsObject(f.objects, f.source) : undefined;
    const destination = path.join(f.root, "destination");
    if (pointer) await writeFile(destination, formatLfsPointer(pointer));
    const temp = path.join(operation === "persist" ? f.objects : f.root, `.captain-lfs-${fixedId}.tmp`);
    const nativeOpen = fs.promises.open;
    fs.promises.open = (async (...args: Parameters<typeof nativeOpen>) => {
      const handle = await nativeOpen(...args);
      if (String(args[0]) === temp) {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); await writeFile(temp, "modified temporary content\n"); };
      }
      return handle;
    }) as typeof nativeOpen;
    syncBuiltinESMExports();
    try {
      await assert.rejects(operation === "persist" ? persistLfsObject(f.objects, f.source) : hydrateLfsObject(f.objects, pointer!, destination));
      if (pointer) assert.deepEqual(await readFile(destination), formatLfsPointer(pointer));
      else await assert.rejects(readFile(path.join(f.objects, expected.oid.slice(0, 2), expected.oid.slice(2, 4), expected.oid)), { code: "ENOENT" });
    } finally { fs.promises.open = nativeOpen; syncBuiltinESMExports(); }
  });

  test(`LFS ${operation} attempts temporary cleanup after close fails`, async t => {
    const f = await fixture(t);
    const pointer = operation === "hydrate" ? await persistLfsObject(f.objects, f.source) : undefined;
    const destination = path.join(f.root, "destination");
    if (pointer) await writeFile(destination, formatLfsPointer(pointer));
    const temp = path.join(operation === "persist" ? f.objects : f.root, `.captain-lfs-${fixedId}.tmp`);
    const nativeOpen = fs.promises.open;
    fs.promises.open = (async (...args: Parameters<typeof nativeOpen>) => {
      const handle = await nativeOpen(...args);
      if (String(args[0]) === temp) {
        const close = handle.close.bind(handle);
        handle.write = (async () => { throw new Error("injected write failure"); }) as typeof handle.write;
        handle.close = async () => { await close(); throw new Error("injected close failure"); };
      }
      return handle;
    }) as typeof nativeOpen;
    syncBuiltinESMExports();
    try {
      await assert.rejects(operation === "persist" ? persistLfsObject(f.objects, f.source) : hydrateLfsObject(f.objects, pointer!, destination), /injected close failure/);
      await assert.rejects(readFile(temp), { code: "ENOENT" });
      if (pointer) assert.deepEqual(await readFile(destination), formatLfsPointer(pointer));
    } finally { fs.promises.open = nativeOpen; syncBuiltinESMExports(); }
  });
}

test("LFS hydration preserves a destination changed during temporary verification", async t => {
  const f = await fixture(t), pointer = await persistLfsObject(f.objects, f.source);
  const destination = path.join(f.root, "destination"), temp = path.join(f.root, `.captain-lfs-${fixedId}.tmp`);
  await writeFile(destination, formatLfsPointer(pointer));
  const nativeOpen = fs.promises.open;
  fs.promises.open = (async (...args: Parameters<typeof nativeOpen>) => {
    const handle = await nativeOpen(...args);
    if (String(args[0]) === temp && (Number(args[1]) & fs.constants.O_EXCL) === 0) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); await writeFile(destination, "external change\n"); };
    }
    return handle;
  }) as typeof nativeOpen;
  syncBuiltinESMExports();
  try {
    await assert.rejects(hydrateLfsObject(f.objects, pointer, destination), /destination changed/);
    assert.equal(await readFile(destination, "utf8"), "external change\n");
  } finally { fs.promises.open = nativeOpen; syncBuiltinESMExports(); }
});
