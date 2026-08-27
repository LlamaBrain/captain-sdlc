import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
async function key(root) { await mkdir(root, { recursive: true }); const file = path.join(root, "authority.key"); try {
    return Buffer.from(await readFile(file, "utf8"), "base64");
}
catch {
    const value = randomBytes(32);
    try {
        await writeFile(file, value.toString("base64"), { flag: "wx", mode: 0o600 });
        return value;
    }
    catch {
        return Buffer.from(await readFile(file, "utf8"), "base64");
    }
} }
const tag = (payload, secret) => createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
export async function writeAuthorized(root, bucket, id, payload) { const dir = path.join(root, bucket); await mkdir(dir, { recursive: true }); const envelope = { payload, tag: tag(payload, await key(root)) }, target = path.join(dir, `${safe(id)}.json`), temp = `${target}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(envelope, null, 2)); await rename(temp, target); }
export async function readAuthorized(root, bucket, id) { const envelope = JSON.parse(await readFile(path.join(root, bucket, `${safe(id)}.json`), "utf8")); const expected = Buffer.from(tag(envelope.payload, await key(root)), "hex"), actual = Buffer.from(String(envelope.tag ?? ""), "hex"); if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("Captain authority tag is invalid"); return envelope.payload; }
const safe = (id) => { if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error("unsafe id"); return id; };
