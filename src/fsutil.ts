import { access, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export function errno(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (err) {
    if (errno(err) === "ENOENT") return false;
    throw err;
  }
}

export async function writeDurable(file: string, data: string | Buffer): Promise<void> {
  const fh = await open(file, "wx", 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** 目录 fsync，让 rename / link 在崩溃后仍然可见。 */
export async function fsyncDirectory(dir: string): Promise<void> {
  const fh = await open(dir, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeDurable(tmp, data);
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fsyncDirectory(path.dirname(file));
}
