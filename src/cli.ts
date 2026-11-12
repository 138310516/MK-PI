#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initCompany } from "./company.ts";
import { ContractError } from "./errors.ts";
import { sendEnvelope } from "./send.ts";
import { startWatch } from "./watch.ts";

const HELP = `一人公司（opc）— 单机协作骨架

用法
  opc init [目录] [--force]
  opc send --root <目录> --id <id> --from <role@site> --to <role@site> \\
           --task-id <id> --type <类型> --body <相对路径> [--priority <级别>]
  opc send --root <目录> --envelope <envelope.json>
  opc watch --root <目录> [--role <角色>] [--once]

命令
  init     生成 company.yaml 和约定目录树
  send     校验信封，写入收件人 mailbox/tmp，再改名进 mailbox/new
  watch    用文件 watch 监视 mailbox/new，唤醒占位岗

信封
  字段：id, from, to, task_id, type, priority, body, created_at
  type：dispatch | result-ready | merge-ready
  priority：immediate | normal（字段模式缺省是 normal）
  from / to：role@site
  body：公司根内的相对文件路径，不能写长报告
  同一个 id 重复投递会被忽略
  字段模式的 created_at 取当前时间；要固定时间请用 --envelope

示例
  opc init demo-company
  opc send --root demo-company --id env-20261112-014-01 --from clerk@home \\
      --to coder-ui@home --task-id task-20261112-014 --type dispatch \\
      --priority normal --body projects/site/tickets/task-20261112-014.md
  opc watch --root demo-company --once
`;

type Flags = Map<string, string | boolean>;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    await run(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function run(argv: string[]): Promise<void> {
  const parsed = parseArgv(argv);
  if (flagBool(parsed.flags, "help") || parsed.command === "help") {
    rejectUnknown(parsed.flags, ["help"]);
    console.log(HELP);
    return;
  }
  switch (parsed.command) {
    case "init":
      await cmdInit(parsed.positionals, parsed.flags);
      return;
    case "send":
      await cmdSend(parsed.positionals, parsed.flags);
      return;
    case "watch":
      await cmdWatch(parsed.positionals, parsed.flags);
      return;
    case undefined:
      console.log(HELP);
      process.exitCode = 1;
      return;
    default:
      throw new ContractError("bad_args", `未知命令 ${parsed.command}`);
  }
}

async function cmdInit(positionals: string[], flags: Flags): Promise<void> {
  rejectUnknown(flags, ["root", "force"]);
  if (positionals.length > 1) {
    throw new ContractError("bad_args", "init 只接受一个目录");
  }
  const dir = positionals[0] ?? flagString(flags, "root") ?? ".";
  const company = await initCompany(dir, { force: flagBool(flags, "force") });
  console.log(`已初始化「一人公司」：${company.company}`);
  console.log(path.resolve(dir));
}

async function cmdSend(positionals: string[], flags: Flags): Promise<void> {
  rejectUnknown(flags, ["root", "envelope", "id", "from", "to", "task-id", "type", "priority", "body"]);
  if (positionals.length > 0) {
    throw new ContractError("bad_args", "send 不接受位置参数");
  }
  const root = path.resolve(flagString(flags, "root") ?? ".");
  const envelopeFile = flagString(flags, "envelope");
  let input: unknown;
  if (envelopeFile) {
    const fieldFlags = ["id", "from", "to", "task-id", "type", "priority", "body"];
    if (fieldFlags.some((key) => flags.has(key))) {
      throw new ContractError("bad_args", "不要同时使用 --envelope 和字段参数");
    }
    let text: string;
    try {
      text = await readFile(envelopeFile, "utf8");
    } catch {
      throw new ContractError("bad_args", `读不到信封文件 ${envelopeFile}`);
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      throw new ContractError("invalid_envelope", `无法解析信封文件 ${envelopeFile}`);
    }
  } else {
    input = {
      id: required(flags, "id"),
      from: required(flags, "from"),
      to: required(flags, "to"),
      task_id: required(flags, "task-id"),
      type: required(flags, "type"),
      priority: flagString(flags, "priority") ?? "normal",
      body: required(flags, "body"),
      created_at: new Date().toISOString(),
    };
  }
  const result = await sendEnvelope(root, input);
  if (result.status === "duplicate") {
    console.log(`已忽略重复信封 ${result.envelope.id}`);
    return;
  }
  const shown = path.relative(process.cwd(), result.file) || result.file;
  console.log(`已投递 ${result.envelope.id} → ${result.envelope.to}`);
  console.log(shown);
}

async function cmdWatch(positionals: string[], flags: Flags): Promise<void> {
  rejectUnknown(flags, ["root", "role", "once"]);
  if (positionals.length > 0) {
    throw new ContractError("bad_args", "watch 不接受位置参数");
  }
  const root = path.resolve(flagString(flags, "root") ?? ".");
  const once = flagBool(flags, "once");
  const running = startWatch({ root, role: flagString(flags, "role") });
  console.log(once ? "正在监视 mailbox/new（--once）…" : "正在监视 mailbox/new，按 Ctrl+C 结束");
  if (!once) {
    const onSignal = (): void => {
      void running.close().finally(() => {
        process.exit(0);
      });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  try {
    await running.ready;
  } catch (err) {
    await running.close();
    throw err;
  }
  if (!once) {
    await new Promise<void>(() => undefined);
    return;
  }
  if (running.processedCount() === 0) {
    console.log("队列是空的，等待新信…");
  }
  try {
    await running.whenDrained();
  } finally {
    const count = running.processedCount();
    await running.close();
    console.log(`已处理 ${count} 封`);
  }
}

function parseArgv(argv: string[]): { command?: string; positionals: string[]; flags: Flags } {
  const flags: Flags = new Map();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      flags.set("help", true);
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        flags.set(key, true);
      } else {
        flags.set(key, next);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      throw new ContractError("bad_args", `未知参数 ${arg}`);
    }
    positionals.push(arg);
  }
  return { command: positionals[0], positionals: positionals.slice(1), flags };
}

function rejectUnknown(flags: Flags, allowed: string[]): void {
  const allow = new Set(allowed);
  for (const key of flags.keys()) {
    if (!allow.has(key)) throw new ContractError("bad_args", `未知参数 --${key}`);
  }
}

function flagString(flags: Flags, key: string): string | undefined {
  const value = flags.get(key);
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}

function flagBool(flags: Flags, key: string): boolean {
  const value = flags.get(key);
  return value === true || value === "true";
}

function required(flags: Flags, key: string): string {
  const value = flagString(flags, key);
  if (!value) throw new ContractError("bad_args", `缺少 --${key}`);
  return value;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  await main();
}
