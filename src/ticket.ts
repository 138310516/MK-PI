import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { isRelativeBodyPath } from "./envelope.ts";
import { ContractError } from "./errors.ts";
import { errno } from "./fsutil.ts";
import type { ArchiveStatus, Ticket } from "./types.ts";

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseTicket(markdown: string, label: string): Ticket {
  let text = markdown;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const match = FRONT_MATTER.exec(text);
  if (!match || match[1] === undefined) {
    throw new ContractError("bad_ticket", `${label} 缺少 YAML 头`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(match[1]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ContractError("bad_ticket", `${label} 的 YAML 头无法解析：${detail}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ContractError("bad_ticket", `${label} 的 YAML 头必须是映射`);
  }
  const record = raw as Record<string, unknown>;
  const goal = oneLine(record.goal, "goal");
  const constraints = stringList(record.constraints, "constraints");
  const inputs = stringList(record.inputs, "inputs");
  const knowledge =
    record.knowledge === undefined ||
    (Array.isArray(record.knowledge) && record.knowledge.length === 0)
      ? []
      : stringList(record.knowledge, "knowledge");
  for (const item of knowledge) assertAcceptedKnowledge(item);
  return {
    goal,
    constraints,
    inputs,
    knowledge,
    note: (match[2] ?? "").trim(),
  };
}

export function assertAcceptedKnowledge(rel: string): void {
  const parts = isRelativeBodyPath(rel) ? rel.split("/") : [];
  const index = parts.indexOf("knowledge");
  if (index < 0 || parts[index + 1] !== "accepted" || !parts[index + 2]) {
    throw new ContractError("bad_ticket", `knowledge 只能指向 knowledge/accepted/ 下的路径：${rel}`);
  }
}

export async function resolveContainedFile(
  root: string,
  relPosix: string,
  label: string,
): Promise<string> {
  if (!isRelativeBodyPath(relPosix)) {
    throw new ContractError("invalid_body", `${label}不是公司根内的相对路径：${relPosix}`);
  }
  const rootReal = await realpath(root);
  const abs = path.resolve(rootReal, relPosix);
  let real: string;
  try {
    real = await realpath(abs);
  } catch (err) {
    if (errno(err) === "ENOENT") {
      throw new ContractError("bad_ticket", `${label}不存在：${relPosix}`);
    }
    throw err;
  }
  const rel = path.relative(rootReal, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ContractError("invalid_body", `${label}越出公司根目录：${relPosix}`);
  }
  const info = await stat(real);
  if (!info.isFile()) {
    throw new ContractError("bad_ticket", `${label}必须是文件：${relPosix}`);
  }
  return real;
}

export function renderArchive(input: {
  taskId: string;
  status: ArchiveStatus;
  conclusion: string;
  artifact: string;
  leftover: string;
}): string {
  return [
    "---",
    `task_id: ${input.taskId}`,
    `status: ${input.status}`,
    "---",
    "",
    `结论：${oneLine(input.conclusion, "结论")}`,
    `产物：${oneLine(input.artifact, "产物")}`,
    `遗留：${oneLine(input.leftover, "遗留")}`,
    "",
  ].join("\n");
}

export function renderResult(input: { taskId: string; role: string; ticket: Ticket }): string {
  const lines = [
    "---",
    `task_id: ${input.taskId}`,
    `role: ${input.role}`,
    "---",
    "",
    `目标：${clip(input.ticket.goal, 500)}`,
    "",
    "约束：",
    ...input.ticket.constraints.slice(0, 20).map((item) => `- ${clip(item, 200)}`),
    "",
    "输入：",
    ...input.ticket.inputs.slice(0, 20).map((item) => `- ${clip(item, 200)}`),
  ];
  if (input.ticket.knowledge.length > 0) {
    lines.push("", "知识：", ...input.ticket.knowledge.slice(0, 20).map((item) => `- ${item}`));
  }
  const noteLine = input.ticket.note
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (noteLine) {
    lines.push("", `补充：${clip(noteLine, 200)}`);
  }
  lines.push("", "占位岗只处理了这张任务单，没有调用模型。", "");
  return lines.join("\n");
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function oneLine(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ContractError("bad_ticket", `${field} 必须是单行非空文本`);
  }
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) {
    throw new ContractError("bad_ticket", `${field} 必须是单行非空文本`);
  }
  return trimmed;
}

function stringList(value: unknown, field: string): string[] {
  if (typeof value === "string") return [oneLine(value, field)];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ContractError("bad_ticket", `${field} 必须是非空字符串或字符串列表`);
  }
  return value.map((item, index) => oneLine(item, `${field}[${index}]`));
}
