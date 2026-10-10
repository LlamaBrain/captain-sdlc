import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

type LeasePayload = { intentId: string; leaseToken: string; [key: string]: unknown };
type LeaseRevision<T extends LeasePayload = LeasePayload> = {
  schemaVersion: 1;
  leaseId: string;
  revision: number;
  previousSha256?: string;
  state: "held" | "released";
  payload: T;
};
type LeaseWatermark = { schemaVersion: 1; leaseId: string; revision: number; revisionSha256: string; previousSha256?: string };

function decodeKey(value: string): Buffer {
  const normalized = value.trim(), decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== normalized) throw new Error("Captain authority key must decode to exactly 32 bytes");
  return decoded;
}

async function key(root: string): Promise<Buffer> {
  await mkdir(root, { recursive: true });
  const file = path.join(root, "authority.key");
  try { return decodeKey(await readFile(file, "utf8")); }
  catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    const value = randomBytes(32), temp = `${file}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
    try {
      await writeFile(temp, value.toString("base64"), { flag: "wx", mode: 0o600 });
      try { await link(temp, file); return value; }
      catch (publish: any) { if (publish.code !== "EEXIST") throw publish; return decodeKey(await readFile(file, "utf8")); }
    } finally { await unlink(temp).catch((cleanup: any) => { if (cleanup.code !== "ENOENT") throw cleanup; }); }
  }
}

const tag = (payload: unknown, secret: Buffer) => createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
const digest = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

export async function writeAuthorized(root: string, bucket: string, id: string, payload: unknown) {
  const dir = path.join(root, bucket); await mkdir(dir, { recursive: true });
  const envelope = { payload, tag: tag(payload, await key(root)) }, target = path.join(dir, `${safe(id)}.json`), temp = `${target}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  try { await writeFile(temp, JSON.stringify(envelope, null, 2), { flag: "wx", mode: 0o600 }); await rename(temp, target); }
  finally { await unlink(temp).catch((error: any) => { if (error.code !== "ENOENT") throw error; }); }
}

export async function readAuthorized<T>(root: string, bucket: string, id: string): Promise<T> {
  const envelope = JSON.parse(await readFile(path.join(root, bucket, `${safe(id)}.json`), "utf8"));
  const expected = Buffer.from(tag(envelope.payload, await key(root)), "hex"), actual = Buffer.from(String(envelope.tag ?? ""), "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Captain authority tag is invalid");
  return envelope.payload as T;
}

export async function putAuthorizedOnceExact<T>(root: string, bucket: string, id: string, payload: T): Promise<T> {
  const dir = path.join(root, bucket); await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${safe(id)}.json`), temp = `${target}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`, envelope = { payload, tag: tag(payload, await key(root)) };
  try {
    await writeFile(temp, JSON.stringify(envelope, null, 2), { flag: "wx", mode: 0o600 });
    try { await link(temp, target); return payload; }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readAuthorized<T>(root, bucket, id);
      if (JSON.stringify(existing) !== JSON.stringify(payload)) throw new Error("signed authorized checkpoint does not match the existing operation");
      return existing;
    }
  } finally { await unlink(temp).catch((error: any) => { if (error.code !== "ENOENT") throw error; }); }
}

async function leaseState<T extends LeasePayload>(root: string, id: string): Promise<LeaseRevision<T> | undefined> {
  const leaseId = safe(id), dir = path.join(root, "lease-revisions"), expression = new RegExp(`^${leaseId}-([0-9]+)\\.json$`); let names: string[] = [], watermarkNames: string[] = [];
  try { names = await readdir(dir); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  try { watermarkNames = await readdir(path.join(root, "lease-watermarks")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const revisions = names.map(name => expression.exec(name)).filter((match): match is RegExpExecArray => Boolean(match)).map(match => Number(match[1])).sort((a, b) => a - b), watermarks = watermarkNames.map(name => expression.exec(name)).filter((match): match is RegExpExecArray => Boolean(match)).map(match => Number(match[1])).sort((a, b) => a - b);
  if (!revisions.length) {
    if (watermarks.length) throw new Error("authorized lease revision tail regressed behind its signed watermark");
    try {
      const legacy = await readAuthorized<T>(root, "leases", leaseId), initial: LeaseRevision<T> = { schemaVersion: 1, leaseId, revision: 0, state: "held", payload: legacy };
      await putAuthorizedOnceExact(root, "lease-revisions", `${leaseId}-0`, initial);
      return leaseState(root, leaseId);
    } catch (error: any) { if (error.code !== "ENOENT") throw error; return undefined; }
  }
  if (revisions[0] !== 0 || revisions.some((revision, index) => revision !== index)) throw new Error("authorized lease revision chain is not contiguous");
  let previous: LeaseRevision<T> | undefined;
  for (const revision of revisions) {
    const current = await readAuthorized<LeaseRevision<T>>(root, "lease-revisions", `${leaseId}-${revision}`);
    if (current.schemaVersion !== 1 || current.leaseId !== leaseId || current.revision !== revision || (revision === 0 ? current.previousSha256 !== undefined : current.previousSha256 !== digest(previous))) throw new Error("authorized lease revision chain is invalid");
    if (!current.payload || typeof current.payload.intentId !== "string" || typeof current.payload.leaseToken !== "string" || !["held", "released"].includes(current.state)) throw new Error("authorized lease revision payload is invalid");
    await writeLeaseWatermark(root, current);
    previous = current;
  }
  if (watermarks.some(revision => revision > previous!.revision)) throw new Error("authorized lease revision tail regressed behind its signed watermark");
  return previous;
}

async function writeLeaseWatermark(root: string, revision: LeaseRevision) { const value: LeaseWatermark = { schemaVersion: 1, leaseId: revision.leaseId, revision: revision.revision, revisionSha256: digest(revision), ...(revision.previousSha256 ? { previousSha256: revision.previousSha256 } : {}) }; await putAuthorizedOnceExact(root, "lease-watermarks", `${revision.leaseId}-${revision.revision}`, value); }

async function appendLeaseRevision<T extends LeasePayload>(root: string, id: string, previous: LeaseRevision<T> | undefined, state: "held" | "released", payload: T): Promise<LeaseRevision<T>> {
  const revision = (previous?.revision ?? -1) + 1, value: LeaseRevision<T> = { schemaVersion: 1, leaseId: safe(id), revision, ...(previous ? { previousSha256: digest(previous) } : {}), state, payload };
  const stored = await putAuthorizedOnceExact(root, "lease-revisions", `${safe(id)}-${revision}`, value); await writeLeaseWatermark(root, stored); return stored;
}

export async function readAuthorizedLease<T extends LeasePayload>(root: string, id: string): Promise<T> {
  const current = await leaseState<T>(root, id);
  if (!current || current.state !== "held") { const error: NodeJS.ErrnoException = new Error("authorized lease is not held"); error.code = "ENOENT"; throw error; }
  return current.payload;
}

export async function readAuthorizedLeaseState<T extends LeasePayload>(root: string, id: string): Promise<{ state: "held" | "released"; payload: T } | undefined> {
  const current = await leaseState<T>(root, id);
  return current && { state: current.state, payload: current.payload };
}

export async function ensureAuthorizedLease<T extends LeasePayload>(root: string, id: string, payload: T): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await leaseState<T>(root, id);
    if (current?.state === "held") {
      if (JSON.stringify(current.payload) === JSON.stringify(payload)) return current.payload;
      throw new Error("authorized resource is already leased by another Captain operation");
    }
    try {
      await appendLeaseRevision(root, id, current, "held", payload);
      const published = await leaseState<T>(root, id);
      if (published?.state === "held" && JSON.stringify(published.payload) === JSON.stringify(payload)) return published.payload;
    } catch (error) { if (!String((error as Error).message).includes("checkpoint does not match")) throw error; }
  }
  throw new Error("authorized resource is already leased by another Captain operation");
}

export async function acquireAuthorizedLease<T extends LeasePayload>(root: string, id: string, payload: T) {
  const current = await leaseState<T>(root, id);
  if (current?.state === "held") throw new Error("authorized resource is already leased by another Captain operation");
  try { await appendLeaseRevision(root, id, current, "held", payload); }
  catch (error) { if (!String((error as Error).message).includes("checkpoint does not match")) throw error; throw new Error("authorized resource is already leased by another Captain operation", { cause: error }); }
  const published = await leaseState<T>(root, id);
  if (published?.state !== "held" || JSON.stringify(published.payload) !== JSON.stringify(payload)) throw new Error("authorized resource is already leased by another Captain operation");
  return id;
}

export async function releaseAuthorizedLease(root: string, id: string, intentId: string, leaseToken: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await leaseState(root, id);
    if (!current) throw new Error("authorized lease generation owner mismatch");
    if (current.state === "released") {
      if (current.payload.intentId === intentId && current.payload.leaseToken === leaseToken) return;
      throw new Error("authorized lease generation owner mismatch");
    }
    if (current.payload.intentId !== intentId || current.payload.leaseToken !== leaseToken) throw new Error("authorized lease generation owner mismatch");
    try { await appendLeaseRevision(root, id, current, "released", current.payload); }
    catch (error) { if (String((error as Error).message).includes("checkpoint does not match")) continue; throw error; }
    const published = await leaseState(root, id);
    if (published?.state === "released" && published.payload.intentId === intentId && published.payload.leaseToken === leaseToken) return;
    if (published?.state === "held" && (published.payload.intentId !== intentId || published.payload.leaseToken !== leaseToken)) throw new Error("authorized lease generation owner mismatch");
  }
  throw new Error("authorized lease release could not establish its exact generation");
}

/** Release one inspected generation without following a replacement lease. */
export async function releaseAuthorizedLeaseAtGeneration(
  root: string, id: string, intentId: string, leaseToken: string,
  expectedRevision: number, resourceGeneration: string,
): Promise<void> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      expectedRevision === Number.MAX_SAFE_INTEGER || !/^[0-9a-f]{64}$/i.test(resourceGeneration)) {
    throw new Error("authorized lease generation selector is invalid");
  }
  const leaseId = safe(id);
  const current = await readAuthorizedLeaseSnapshotReadOnly(root, leaseId);
  if (!current || current.legacy || current.payload.intentId !== intentId ||
      current.payload.leaseToken !== leaseToken) {
    throw new Error("authorized lease generation owner mismatch");
  }
  const selectedGeneration = digest({ leaseId, revision: expectedRevision, state: "held", payload: current.payload });
  if (selectedGeneration !== resourceGeneration.toLowerCase()) {
    throw new Error("authorized lease generation changed");
  }
  // Repeating this exact release can never adopt a subsequently held generation.
  if (current.state === "released" && current.revision === expectedRevision + 1) return;
  if (current.state !== "held" || current.revision !== expectedRevision) {
    throw new Error("authorized lease generation changed");
  }
  const previous = await readAuthorizedReadOnly<LeaseRevision>(root, "lease-revisions", `${leaseId}-${expectedRevision}`);
  // Publication is an immutable N+1 compare-and-set. There is deliberately no
  // retry loop that could follow a newly acquired generation with reused tokens.
  await appendLeaseRevision(root, leaseId, previous, "released", previous.payload);
  const published = await readAuthorizedLeaseSnapshotReadOnly(root, leaseId);
  if (published?.state !== "released" || published.revision !== expectedRevision + 1 ||
      JSON.stringify(published.payload) !== JSON.stringify(current.payload)) {
    throw new Error("authorized lease release could not establish its exact generation");
  }
}

const safe = (id: string) => { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("unsafe id"); return id; };

/** Authenticate existing evidence without bootstrapping keys or checkpoints. */
export async function readAuthorizedReadOnly<T>(root: string, bucket: string, id: string): Promise<T> {
  const secret = decodeKey(await readFile(path.join(root, "authority.key"), "utf8"));
  const envelope = JSON.parse(await readFile(path.join(root, bucket, `${safe(id)}.json`), "utf8"));
  if (typeof envelope.tag !== "string" || !/^[0-9a-f]{64}$/i.test(envelope.tag)) throw new Error("Captain authority tag is invalid");
  const expected = Buffer.from(tag(envelope.payload, secret), "hex"), actual = Buffer.from(envelope.tag, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Captain authority tag is invalid");
  return envelope.payload as T;
}

/** Inspect signed lease ownership without migration, watermark publication or recovery. */
export async function readAuthorizedLeaseSnapshotReadOnly<T extends LeasePayload>(root: string, id: string): Promise<{ state: "held" | "released"; payload: T; revision: number | null; legacy: boolean } | undefined> {
  const leaseId = safe(id);
  // Absence is meaningful only in an existing authenticated authority store.
  decodeKey(await readFile(path.join(root, "authority.key"), "utf8"));
  const expression = new RegExp(`^${leaseId}-([0-9]+)\\.json$`);
  const names = async (bucket: string): Promise<string[]> => {
    try { return await readdir(path.join(root, bucket)); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; return []; }
  };
  const numbers = (entries: string[]) => entries.map(name => expression.exec(name)).filter((match): match is RegExpExecArray => Boolean(match)).map(match => Number(match[1])).sort((a, b) => a - b);
  const revisions = numbers(await names("lease-revisions")), watermarks = numbers(await names("lease-watermarks"));
  const validPayload = (value: unknown): value is T => Boolean(value && typeof value === "object" && typeof (value as LeasePayload).intentId === "string" && typeof (value as LeasePayload).leaseToken === "string");
  if (!revisions.length) {
    if (watermarks.length) throw new Error("authorized lease revision tail regressed behind its signed watermark");
    let legacy: T;
    try { legacy = await readAuthorizedReadOnly<T>(root, "leases", leaseId); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; return undefined; }
    if (!validPayload(legacy)) throw new Error("authorized legacy lease payload is invalid");
    return { state: "held", payload: legacy, revision: null, legacy: true };
  }
  if (revisions[0] !== 0 || revisions.some((revision, index) => revision !== index)) throw new Error("authorized lease revision chain is not contiguous");
  if (watermarks.some(revision => revision > revisions[revisions.length - 1])) throw new Error("authorized lease revision tail regressed behind its signed watermark");
  let previous: LeaseRevision<T> | undefined;
  for (const revision of revisions) {
    const current = await readAuthorizedReadOnly<LeaseRevision<T>>(root, "lease-revisions", `${leaseId}-${revision}`);
    if (current.schemaVersion !== 1 || current.leaseId !== leaseId || current.revision !== revision || (revision === 0 ? current.previousSha256 !== undefined : current.previousSha256 !== digest(previous))) throw new Error("authorized lease revision chain is invalid");
    if (!validPayload(current.payload) || !["held", "released"].includes(current.state)) throw new Error("authorized lease revision payload is invalid");
    const existing = await readAuthorizedReadOnly<LeaseWatermark>(root, "lease-watermarks", `${leaseId}-${revision}`);
    const expected: LeaseWatermark = { schemaVersion: 1, leaseId, revision, revisionSha256: digest(current), ...(current.previousSha256 ? { previousSha256: current.previousSha256 } : {}) };
    if (JSON.stringify(existing) !== JSON.stringify(expected)) throw new Error("signed lease watermark checkpoint does not match its revision");
    previous = current;
  }
  return { state: previous!.state, payload: previous!.payload, revision: previous!.revision, legacy: false };
}

/** Preserve the existing public read-only lease result shape. */
export async function readAuthorizedLeaseStateReadOnly<T extends LeasePayload>(root: string, id: string): Promise<{ state: "held" | "released"; payload: T } | undefined> {
  const snapshot = await readAuthorizedLeaseSnapshotReadOnly<T>(root, id);
  return snapshot && { state: snapshot.state, payload: snapshot.payload };
}
