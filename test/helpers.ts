import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Envelope } from "../src/types.ts";

export async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "opc-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function sampleEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "env-20261112-014-01",
    from: "clerk@home",
    to: "coder-ui@home",
    task_id: "task-20261112-014",
    type: "dispatch",
    priority: "normal",
    body: "projects/site/tickets/task-20261112-014.md",
    created_at: "2026-11-12T12:00:00+08:00",
    ...overrides,
  };
}

export function ticketMarkdown(options?: {
  goal?: string;
  knowledge?: string[];
  note?: string;
  input?: string;
}): string {
  const lines = [
    "---",
    `goal: ${options?.goal ?? "把首页标题改成「一人公司」"}`,
    "constraints:",
    "  - 只改标题文案",
    "  - 不新增依赖",
    "inputs:",
    `  - ${options?.input ?? "projects/site/tickets/task-20261112-014.md"}`,
  ];
  if (options?.knowledge && options.knowledge.length > 0) {
    lines.push("knowledge:");
    for (const item of options.knowledge) lines.push(`  - ${item}`);
  }
  lines.push("---", "", options?.note ?? "标题改为「一人公司」。", "");
  return lines.join("\n");
}
