import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { loadCompany } from "./company.ts";
import { compareEnvelopes } from "./envelope.ts";
import { ContractError } from "./errors.ts";
import {
  claim,
  envelopePath,
  listState,
  readStoredEnvelope,
  repairMailbox,
  settle,
} from "./mailbox.ts";
import { assertKnownAddress, watchBindings, type MailboxBinding } from "./paths.ts";
import type { Company, Envelope } from "./types.ts";
import { executeDispatch } from "./worker.ts";

/**
 * 本地唤醒只走 fs.watch(mailbox/new)。
 * 启动时先消化已经躺在 new/ 和 cur/ 里的信（进程重启后续做），之后不轮询。
 * 同一轮里如果占位岗又投下回执，会顺着把各个 new/ 排空，避免回执干等下一次事件。
 */
export interface WatchOptions {
  root: string;
  role?: string;
  log?: (line: string) => void;
}

export interface RunningWatch {
  ready: Promise<void>;
  whenDrained(): Promise<void>;
  close(): Promise<void>;
  processedCount(): number;
}

export function startWatch(options: WatchOptions): RunningWatch {
  const log = options.log ?? ((line: string) => console.log(line));
  const watchers: FSWatcher[] = [];
  let bindings: MailboxBinding[] = [];
  let company: Company | undefined;
  let root = path.resolve(options.root);
  let processed = 0;
  let closed = false;
  let again = false;
  let pending: Promise<void> | null = null;
  let pulseResolve: () => void = () => undefined;
  let pulse = new Promise<void>((resolve) => {
    pulseResolve = resolve;
  });

  function signalPulse(): void {
    const resolve = pulseResolve;
    pulse = new Promise<void>((next) => {
      pulseResolve = next;
    });
    resolve();
  }

  function schedule(): Promise<void> {
    if (pending) {
      again = true;
      return pending;
    }
    if (closed) return Promise.resolve();
    let resolveRun: () => void = () => undefined;
    let rejectRun: (err: unknown) => void = () => undefined;
    pending = new Promise<void>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    void runCascade().then(resolveRun, rejectRun);
    return pending;
  }

  async function runCascade(): Promise<void> {
    try {
      let passes = 0;
      do {
        passes += 1;
        again = false;
        if (passes > 1000) {
          log("监视中止：信箱在一轮里没有排空");
          break;
        }
        for (const binding of bindings) {
          try {
            await drainBinding(binding);
          } catch (err) {
            log(`信箱出错 ${binding.role.id}：${messageOf(err)}`);
          }
        }
      } while (!closed && (again || (await countNew()) > 0));
    } catch (err) {
      log(`监视中断：${messageOf(err)}`);
    } finally {
      const follow = !closed && again;
      pending = null;
      if (follow) schedule();
      else signalPulse();
    }
  }

  async function drainBinding(binding: MailboxBinding): Promise<void> {
    for (const id of await listState(binding.mailbox, "cur")) {
      await finishClaimed(binding, id);
    }
    const items: Array<{ id: string; envelope: Envelope | null }> = [];
    for (const id of await listState(binding.mailbox, "new")) {
      try {
        items.push({
          id,
          envelope: await readStoredEnvelope(envelopePath(binding.mailbox, "new", id)),
        });
      } catch {
        items.push({ id, envelope: null });
      }
    }
    items.sort((a, b) => {
      if (a.envelope && b.envelope) return compareEnvelopes(a.envelope, b.envelope);
      if (a.envelope) return -1;
      if (b.envelope) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    for (const item of items) {
      if (!(await claim(binding.mailbox, item.id))) continue;
      await finishClaimed(binding, item.id);
    }
  }

  async function finishClaimed(binding: MailboxBinding, id: string): Promise<void> {
    try {
      const envelope = await readStoredEnvelope(envelopePath(binding.mailbox, "cur", id));
      if (envelope.id !== id) {
        throw new ContractError("invalid_envelope", `文件名 ${id} 与信封 id ${envelope.id} 不一致`);
      }
      await handle(envelope, binding);
      await settle(binding.mailbox, id, "done");
    } catch (err) {
      const reason = messageOf(err);
      try {
        await settle(binding.mailbox, id, "failed", reason);
      } catch (settleErr) {
        log(`结案失败 ${id}：${messageOf(settleErr)}`);
      }
      log(`[${binding.role.id}] 失败 ${id}：${reason}`);
    }
    processed += 1;
  }

  async function handle(envelope: Envelope, binding: MailboxBinding): Promise<void> {
    if (!company) throw new ContractError("bad_company", "公司配置还没装载");
    const to = assertKnownAddress(company, envelope.to);
    assertKnownAddress(company, envelope.from);
    if (to.role.id !== binding.role.id) {
      throw new ContractError(
        "misrouted",
        `这封信在 ${binding.role.id} 的信箱里，收件人却是 ${envelope.to}`,
      );
    }
    const label = `${binding.role.id}@${to.site}`;
    log(`[${label}] 收到 ${envelope.type} ${envelope.id} 任务 ${envelope.task_id}`);
    if (envelope.type === "result-ready" || envelope.type === "merge-ready") {
      log(`[${label}] 签收 ${envelope.type} ${envelope.id}`);
      return;
    }
    if (binding.role.kind !== "worker" && binding.role.kind !== "merge") {
      throw new ContractError("not_executable", `${binding.role.kind} 岗在 v0 不执行任务单`);
    }
    if (!binding.projectId) {
      throw new ContractError("misrouted", "执行岗没有项目信箱");
    }
    const outcome = await executeDispatch({
      root,
      company,
      envelope,
      projectId: binding.projectId,
    });
    log(`[${label}] 已写入存档 ${outcome.archiveRel}`);
    if (outcome.delivery.status === "duplicate") {
      log(`[${label}] 回执已存在 ${outcome.reply.id}`);
    } else {
      log(`[${label}] 已回执 result-ready ${outcome.reply.id} → ${outcome.reply.to}`);
    }
  }

  async function countNew(): Promise<number> {
    let total = 0;
    for (const binding of bindings) {
      total += (await listState(binding.mailbox, "new")).length;
    }
    return total;
  }

  async function countPending(): Promise<number> {
    let total = 0;
    for (const binding of bindings) {
      total += (await listState(binding.mailbox, "new")).length;
      total += (await listState(binding.mailbox, "cur")).length;
    }
    return total;
  }

  const boot = (async () => {
    root = path.resolve(options.root);
    company = await loadCompany(root);
    bindings = watchBindings(root, company, options.role);
    for (const binding of bindings) {
      const repaired = await repairMailbox(binding.mailbox);
      if (repaired > 0) {
        log(`已补投 ${repaired} 封未完成落盘的信（${binding.role.id}）`);
      }
      const newDir = path.join(binding.mailbox, "new");
      const watcher = watch(newDir, { persistent: true }, () => {
        schedule();
      });
      watcher.on("error", (err) => {
        log(`watch 错误 ${newDir}：${err.message}`);
      });
      watchers.push(watcher);
    }
    await schedule();
  })();

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await boot;
    } catch {
      // 启动失败时也要关掉已经挂上的 watcher。
    }
    for (const watcher of watchers) watcher.close();
    if (pending) {
      try {
        await pending;
      } catch {
        // runCascade 自己会记日志。
      }
    }
  }

  return {
    ready: boot,
    processedCount: () => processed,
    async whenDrained() {
      await boot;
      for (;;) {
        const signaled = pulse;
        if (closed) throw new ContractError("closed", "监视已关闭");
        if (processed > 0 && pending === null && (await countPending()) === 0) return;
        await signaled;
      }
    },
    close,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
