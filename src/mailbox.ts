import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isEnvelopeId, serializeEnvelope, validateEnvelope } from "./envelope.ts";
import { errno, fileExists, fsyncDirectory, writeDurable } from "./fsutil.ts";
import type { DeliverResult, Envelope, MailState } from "./types.ts";

const PARTS = ["tmp", "new", "cur", "done", "failed", "seen"] as const;

/**
 * Maildir 式信箱。
 * 投递：正文写入 tmp，fsync 后硬链接到 seen（id 台账，独占），再 rename 进 new。
 * 处理：new → cur → done，失败则 cur → failed。
 * seen 不参与 watch，只用来在改名之后仍然挡住同一个 id。
 */
export async function ensureMailbox(mailbox: string): Promise<void> {
  for (const part of PARTS) {
    await mkdir(path.join(mailbox, part), { recursive: true });
  }
}

export function envelopePath(mailbox: string, state: MailState | "seen", id: string): string {
  return path.join(mailbox, state, `${id}.json`);
}

export async function deliver(mailbox: string, input: unknown): Promise<DeliverResult> {
  const envelope = validateEnvelope(input);
  await ensureMailbox(mailbox);
  const existing = await locate(mailbox, envelope.id);
  if (existing) {
    return { status: "duplicate", file: existing.file };
  }

  const fileName = `${envelope.id}.json`;
  const seenPath = path.join(mailbox, "seen", fileName);
  const destPath = path.join(mailbox, "new", fileName);
  if (await fileExists(seenPath)) {
    return { status: "duplicate", file: seenPath };
  }

  const tmpPath = path.join(
    mailbox,
    "tmp",
    `${envelope.id}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.json`,
  );
  await writeDurable(tmpPath, serializeEnvelope(envelope));
  try {
    await link(tmpPath, seenPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    if (errno(err) === "EEXIST") {
      const found = await locate(mailbox, envelope.id);
      return { status: "duplicate", file: found?.file ?? seenPath };
    }
    throw err;
  }
  await fsyncDirectory(path.dirname(seenPath));
  try {
    await rename(tmpPath, destPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  // rename 到自身硬链接时不会删掉 tmp 这个名字，清掉残留。
  await unlink(tmpPath).catch(() => undefined);
  await fsyncDirectory(path.dirname(destPath));
  return { status: "accepted", file: destPath };
}

/** 崩溃发生在 seen 已登记、new 还没出现时，把台账里的信补投进 new。 */
export async function repairMailbox(mailbox: string): Promise<number> {
  await ensureMailbox(mailbox);
  const seenDir = path.join(mailbox, "seen");
  const names = await readdir(seenDir);
  let repaired = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isEnvelopeId(id)) continue;
    if (await locate(mailbox, id)) continue;
    try {
      await link(path.join(seenDir, name), path.join(mailbox, "new", name));
      repaired += 1;
    } catch (err) {
      if (errno(err) !== "EEXIST") throw err;
    }
  }
  if (repaired > 0) {
    await fsyncDirectory(path.join(mailbox, "new"));
  }
  return repaired;
}

export async function locate(
  mailbox: string,
  id: string,
): Promise<{ state: MailState; file: string } | null> {
  for (const state of ["new", "cur", "done", "failed"] as const) {
    const file = envelopePath(mailbox, state, id);
    if (await fileExists(file)) return { state, file };
  }
  return null;
}

export async function listState(mailbox: string, state: MailState): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(mailbox, state));
  } catch (err) {
    if (errno(err) === "ENOENT") return [];
    throw err;
  }
  const ids: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (isEnvelopeId(id)) ids.push(id);
  }
  ids.sort();
  return ids;
}

/** 认领：new → cur。文件已经被别人拿走时返回 false。 */
export async function claim(mailbox: string, id: string): Promise<boolean> {
  try {
    await rename(envelopePath(mailbox, "new", id), envelopePath(mailbox, "cur", id));
    return true;
  } catch (err) {
    if (errno(err) === "ENOENT") return false;
    throw err;
  }
}

export async function settle(
  mailbox: string,
  id: string,
  outcome: "done" | "failed",
  reason?: string,
): Promise<void> {
  await rename(envelopePath(mailbox, "cur", id), envelopePath(mailbox, outcome, id));
  if (outcome === "failed" && reason) {
    await writeFile(path.join(mailbox, "failed", `${id}.reason.txt`), `${reason.trim()}\n`);
  }
}

export async function readStoredEnvelope(file: string): Promise<Envelope> {
  const text = await readFile(file, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`无法解析信封 ${file}`);
  }
  return validateEnvelope(raw);
}

