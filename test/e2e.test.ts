import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { initCompany } from "../src/company.ts";
import { resultReadyId } from "../src/envelope.ts";
import { sendEnvelope } from "../src/send.ts";
import { startWatch, type RunningWatch } from "../src/watch.ts";
import { sampleEnvelope, ticketMarkdown, withRoot } from "./helpers.ts";

const TASK = "task-20261112-014";
const TICKET = `projects/site/tickets/${TASK}.md`;
const GOAL = "把首页标题改成「一人公司」";
const NOTE = "NOTE-ONLY-IN-RESULT";
const LEAK = "LEAK-MARKER-9f3c";

describe("派单 → 唤醒 → 存档 → result-ready", () => {
  test("监视武装之后才投递，文件 watch 叫醒占位岗", { timeout: 8_000 }, async () => {
    await withRoot(async (root) => {
      await initCompany(root);
      await writeTicket(root);
      const logs: string[] = [];
      const running = startWatch({ root, log: (line) => logs.push(line) });
      try {
        await running.ready;
        assert.equal(running.processedCount(), 0);
        const sent = await sendEnvelope(root, sampleEnvelope());
        assert.equal(sent.status, "accepted");
        await waitDrained(running);

        const archiveRel = `projects/site/agents/coder-ui/archive/${TASK}.md`;
        const archive = await readFile(path.join(root, archiveRel), "utf8");
        assert.match(archive, /status: done/);
        assert.match(archive, /结论：占位岗已按任务单完成，未调用模型。/);
        assert.match(archive, new RegExp(`产物：projects/site/agents/coder-ui/out/${TASK}/`));
        assert.match(archive, /遗留：无/);
        assert.equal(archive.includes(NOTE), false);
        assert.equal(archive.includes(LEAK), false);
        assert.equal(archive.includes(GOAL), false);

        const result = await readFile(
          path.join(root, "projects/site/agents/coder-ui/out", TASK, "result.md"),
          "utf8",
        );
        assert.match(result, new RegExp(GOAL));
        assert.match(result, new RegExp(NOTE));
        assert.equal(result.includes(LEAK), false);

        const dispatch = JSON.parse(
          await readFile(
            path.join(root, "projects/site/agents/coder-ui/mailbox/done/env-20261112-014-01.json"),
            "utf8",
          ),
        ) as { type: string; body: string };
        assert.equal(dispatch.type, "dispatch");
        assert.equal(dispatch.body, TICKET);

        const replyId = resultReadyId("env-20261112-014-01");
        const replyText = await readFile(
          path.join(root, "clerk/mailbox/done", `${replyId}.json`),
          "utf8",
        );
        const reply = JSON.parse(replyText) as {
          type: string;
          from: string;
          to: string;
          task_id: string;
          body: string;
        };
        assert.equal(reply.type, "result-ready");
        assert.equal(reply.from, "coder-ui@home");
        assert.equal(reply.to, "clerk@home");
        assert.equal(reply.task_id, TASK);
        assert.equal(reply.body, archiveRel);
        assert.equal(replyText.includes(GOAL), false);
        assert.equal(replyText.includes(NOTE), false);

        assert.ok(logs.some((line) => line.includes(`[coder-ui@home] 已回执 result-ready ${replyId}`)));
        assert.ok(logs.some((line) => line.includes("[clerk@home] 签收 result-ready")));

        const before = await stat(path.join(root, archiveRel));
        const count = running.processedCount();
        const again = await sendEnvelope(root, sampleEnvelope());
        assert.equal(again.status, "duplicate");
        await delay(200);
        assert.equal(running.processedCount(), count);
        const after = await stat(path.join(root, archiveRel));
        assert.equal(after.mtimeMs, before.mtimeMs);
      } finally {
        await running.close();
      }
    });
  });

  test("immediate 比更早的 normal 先执行", { timeout: 8_000 }, async () => {
    await withRoot(async (root) => {
      await initCompany(root);
      await writeTicket(root);
      await sendEnvelope(
        root,
        sampleEnvelope({
          id: "env-normal",
          priority: "normal",
          created_at: "2026-11-12T01:00:00Z",
          task_id: "task-normal",
        }),
      );
      await sendEnvelope(
        root,
        sampleEnvelope({
          id: "env-immediate",
          priority: "immediate",
          created_at: "2026-11-12T18:00:00Z",
          task_id: "task-immediate",
        }),
      );
      const logs: string[] = [];
      const running = startWatch({ root, log: (line) => logs.push(line) });
      try {
        await running.ready;
        await waitDrained(running);
        const lines = logs.filter((line) => line.includes("收到 dispatch"));
        assert.match(lines[0] ?? "", /env-immediate/);
        assert.match(lines[1] ?? "", /env-normal/);
      } finally {
        await running.close();
      }
    });
  });

  test("任务单不存在时进 failed，不回执", { timeout: 8_000 }, async () => {
    await withRoot(async (root) => {
      await initCompany(root);
      const running = startWatch({ root, log: () => undefined });
      try {
        await running.ready;
        await sendEnvelope(
          root,
          sampleEnvelope({
            id: "env-missing",
            body: "projects/site/tickets/missing.md",
          }),
        );
        await waitDrained(running);
        const reason = await readFile(
          path.join(root, "projects/site/agents/coder-ui/mailbox/failed/env-missing.reason.txt"),
          "utf8",
        );
        assert.match(reason, /任务单不存在/);
        assert.deepEqual(await readdir(path.join(root, "clerk/mailbox/done")), []);
        assert.deepEqual(await readdir(path.join(root, "clerk/mailbox/new")), []);
      } finally {
        await running.close();
      }
    });
  });

  test("knowledge 指向 inbox 时拒绝执行", { timeout: 8_000 }, async () => {
    await withRoot(async (root) => {
      await initCompany(root);
      const bad = "projects/site/knowledge/inbox/secret.md";
      await mkdir(path.dirname(path.join(root, bad)), { recursive: true });
      await writeFile(path.join(root, bad), "不应该被执行\n", "utf8");
      await writeTicket(root, [bad]);
      const running = startWatch({ root, log: () => undefined });
      try {
        await running.ready;
        await sendEnvelope(root, sampleEnvelope({ id: "env-bad-knowledge" }));
        await waitDrained(running);
        const reason = await readFile(
          path.join(root, "projects/site/agents/coder-ui/mailbox/failed/env-bad-knowledge.reason.txt"),
          "utf8",
        );
        assert.match(reason, /knowledge\/accepted/);
        await assert.rejects(() =>
          stat(path.join(root, "projects/site/agents/coder-ui/archive", `${TASK}.md`)),
        );
      } finally {
        await running.close();
      }
    });
  });

  test("合法知识路径只记录路径，存档标 needs-review", { timeout: 8_000 }, async () => {
    await withRoot(async (root) => {
      await initCompany(root);
      const knowledge = "projects/site/knowledge/accepted/naming.md";
      await mkdir(path.dirname(path.join(root, knowledge)), { recursive: true });
      await writeFile(path.join(root, knowledge), "SECRET-KNOWLEDGE-BODY\n", "utf8");
      await writeTicket(root, [knowledge]);
      const running = startWatch({ root, log: () => undefined });
      try {
        await running.ready;
        await sendEnvelope(root, sampleEnvelope({ id: "env-review" }));
        await waitDrained(running);
        const archive = await readFile(
          path.join(root, "projects/site/agents/coder-ui/archive", `${TASK}.md`),
          "utf8",
        );
        assert.match(archive, /status: needs-review/);
        assert.match(archive, /遗留：知识未核对/);
        assert.equal(archive.includes("SECRET-KNOWLEDGE-BODY"), false);
        const result = await readFile(
          path.join(root, "projects/site/agents/coder-ui/out", TASK, "result.md"),
          "utf8",
        );
        assert.match(result, new RegExp(knowledge));
        assert.equal(result.includes("SECRET-KNOWLEDGE-BODY"), false);
        await stat(path.join(root, "clerk/mailbox/done", `${resultReadyId("env-review")}.json`));
      } finally {
        await running.close();
      }
    });
  });

  test("merge-ready 只签收，知识岗不执行派单", { timeout: 8_000 }, async () => {
    await withRoot(async (root) => {
      await initCompany(root);
      await writeTicket(root);
      const running = startWatch({ root, log: () => undefined });
      try {
        await running.ready;
        await sendEnvelope(root, {
          id: "env-merge-1",
          from: "coder-ui@home",
          to: "clerk@home",
          task_id: TASK,
          type: "merge-ready",
          priority: "normal",
          body: `projects/site/agents/coder-ui/archive/${TASK}.md`,
          created_at: "2026-11-12T12:00:00Z",
        });
        await sendEnvelope(
          root,
          sampleEnvelope({
            id: "env-to-knowledge",
            to: "knowledge@home",
          }),
        );
        await waitDrained(running);
        const acked = JSON.parse(
          await readFile(path.join(root, "clerk/mailbox/done/env-merge-1.json"), "utf8"),
        ) as { type: string };
        assert.equal(acked.type, "merge-ready");
        const reason = await readFile(
          path.join(root, "projects/site/agents/knowledge/mailbox/failed/env-to-knowledge.reason.txt"),
          "utf8",
        );
        assert.match(reason, /不执行任务单/);
        await assert.rejects(() =>
          stat(path.join(root, "projects/site/agents/coder-ui/archive", `${TASK}.md`)),
        );
      } finally {
        await running.close();
      }
    });
  });

  test("损坏的信封被移到 failed", { timeout: 8_000 }, async () => {
    await withRoot(async (root) => {
      await initCompany(root);
      const running = startWatch({ root, log: () => undefined });
      try {
        await running.ready;
        await writeFile(
          path.join(root, "projects/site/agents/coder-ui/mailbox/new/bad-envelope.json"),
          "{",
          "utf8",
        );
        await waitDrained(running);
        const reason = await readFile(
          path.join(root, "projects/site/agents/coder-ui/mailbox/failed/bad-envelope.reason.txt"),
          "utf8",
        );
        assert.match(reason, /无法解析/);
      } finally {
        await running.close();
      }
    });
  });
});

async function writeTicket(root: string, knowledge?: string[]): Promise<void> {
  const file = path.join(root, TICKET);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, ticketMarkdown({ goal: GOAL, note: NOTE, knowledge }), "utf8");
  await writeFile(path.join(root, "projects/site/tickets/other.md"), `# ${LEAK}\n`, "utf8");
}

async function waitDrained(running: RunningWatch): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("监视没有在时限内排空")), 4_000);
  });
  try {
    await Promise.race([running.whenDrained(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
