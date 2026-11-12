import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ticketMarkdown, withRoot } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("opc", () => {
  test("帮助是中文", async () => {
    const help = await runCli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /用法/);
    assert.match(help.stdout, /不能写长报告/);
    assert.match(help.stdout, /没有 nudge|dispatch \| result-ready \| merge-ready/);
  });

  test("缺少命令或命令写错时失败", async () => {
    const bare = await runCli([]);
    assert.equal(bare.code, 1);
    assert.match(bare.stdout, /用法/);
    const unknown = await runCli(["nudge"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /未知命令/);
  });

  test("按演示走完一张任务单，重复 id 不会再执行", { timeout: 15_000 }, async () => {
    await withRoot(async (root) => {
      const init = await runCli(["init", root]);
      assert.equal(init.code, 0, init.stderr);
      assert.match(init.stdout, /已初始化/);

      const ticket = path.join(root, "projects/site/tickets/task-20261112-014.md");
      await mkdir(path.dirname(ticket), { recursive: true });
      await writeFile(
        ticket,
        ticketMarkdown({
          goal: "把首页标题改成「一人公司」",
          note: "标题改为「一人公司」。",
        }),
        "utf8",
      );

      const watch = spawnWatch(["watch", "--root", root, "--once"]);
      try {
        await watch.waitFor("等待新信");
        const sendArgs = [
          "send",
          "--root",
          root,
          "--id",
          "env-20261112-014-01",
          "--from",
          "clerk@home",
          "--to",
          "coder-ui@home",
          "--task-id",
          "task-20261112-014",
          "--type",
          "dispatch",
          "--priority",
          "normal",
          "--body",
          "projects/site/tickets/task-20261112-014.md",
        ];
        const sent = await runCli(sendArgs);
        assert.equal(sent.code, 0, sent.stderr);
        assert.match(sent.stdout, /已投递 env-20261112-014-01 → coder-ui@home/);

        const finished = await watch.exited;
        assert.equal(finished.code, 0, `${finished.stdout}\n${finished.stderr}`);
        assert.match(finished.stdout, /已回执 result-ready/);
        assert.match(finished.stdout, /签收 result-ready/);
        assert.match(finished.stdout, /已处理/);

        const archive = await readFile(
          path.join(root, "projects/site/agents/coder-ui/archive/task-20261112-014.md"),
          "utf8",
        );
        assert.match(archive, /status: done/);
        const reply = JSON.parse(
          await readFile(
            path.join(root, "clerk/mailbox/done/env-20261112-014-01--result-ready.json"),
            "utf8",
          ),
        ) as { type: string; body: string };
        assert.equal(reply.type, "result-ready");
        assert.equal(reply.body, "projects/site/agents/coder-ui/archive/task-20261112-014.md");
        await readFile(
          path.join(root, "projects/site/agents/coder-ui/mailbox/done/env-20261112-014-01.json"),
          "utf8",
        );
        await readFile(
          path.join(root, "projects/site/agents/coder-ui/out/task-20261112-014/result.md"),
          "utf8",
        );

        const duplicate = await runCli(sendArgs);
        assert.equal(duplicate.code, 0, duplicate.stderr);
        assert.match(duplicate.stdout, /已忽略重复信封 env-20261112-014-01/);
      } finally {
        watch.kill();
      }
    });
  });
});

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function spawnWatch(args: string[]): {
  waitFor: (text: string) => Promise<void>;
  exited: Promise<{ code: number | null; stdout: string; stderr: string }>;
  kill: () => void;
} {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return {
    exited,
    kill: () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    },
    async waitFor(text: string) {
      const start = Date.now();
      while (!stdout.includes(text)) {
        if (child.exitCode !== null) {
          throw new Error(`watch 提前退出 ${child.exitCode}\n${stdout}\n${stderr}`);
        }
        if (Date.now() - start > 5_000) {
          throw new Error(`等不到「${text}」\n${stdout}\n${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}
