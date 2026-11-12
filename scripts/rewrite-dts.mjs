import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dir = path.resolve("dist");
for (const name of await readdir(dir)) {
  if (!name.endsWith(".d.ts")) continue;
  const file = path.join(dir, name);
  const text = await readFile(file, "utf8");
  const next = text.replaceAll('.ts"', '.js"');
  if (next !== text) await writeFile(file, next);
}
