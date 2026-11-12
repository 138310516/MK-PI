import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { serializeEnvelope } from "../src/envelope.ts";
import { ContractError } from "../src/errors.ts";
import {
  claim,
  deliver,
  ensureMailbox,
  envelopePath,
  locate,
  repairMailbox,
  settle,
} from "../src/mailbox.ts";
import { sampleEnvelope, withRoot } from "./helpers.ts";

describe("mailbox", () => {
  test("原子落盘后只出现在 new，tmp 不留草稿", async () => {
    await withRoot(async (root) => {
      const mailbox = path.join(root, "mailbox");
      await ensureMailbox(mailbox);
      const envelope = sampleEnvelope();
      const result = await deliver(mailbox, envelope);
      assert.equal(result.status, "accepted");
      assert.equal((await locate(mailbox, envelope.id))?.state, "new");
      const stored = await readFile(envelopePath(mailbox, "new", envelope.id), "utf8");
      assert.equal(stored, serializeEnvelope(envelope));
      const seen = await readFile(envelopePath(mailbox, "seen", envelope.id), "utf8");
      assert.equal(seen, stored);
      const tmpLeft = (await readdir(path.join(mailbox, "tmp"))).filter((name) => name.endsWith(".json"));
      assert.deepEqual(tmpLeft, []);
      for (const state of ["cur", "done", "failed"] as const) {
        assert.equal(await locateIn(mailbox, state, envelope.id), false);
      }
    });
  });

  test("new → cur → done，之后同一个 id 被忽略", async () => {
    await withRoot(async (root) => {
      const mailbox = path.join(root, "mailbox");
      const envelope = sampleEnvelope();
      await deliver(mailbox, envelope);
      assert.equal(await claim(mailbox, envelope.id), true);
      assert.equal((await locate(mailbox, envelope.id))?.state, "cur");
      assert.equal(await claim(mailbox, envelope.id), false);
      await settle(mailbox, envelope.id, "done");
      assert.equal((await locate(mailbox, envelope.id))?.state, "done");
      const again = await deliver(mailbox, envelope);
      assert.equal(again.status, "duplicate");
      assert.equal((await locate(mailbox, envelope.id))?.state, "done");
    });
  });

  test("失败落到 failed 并写下原因，重复 id 仍被忽略", async () => {
    await withRoot(async (root) => {
      const mailbox = path.join(root, "mailbox");
      const envelope = sampleEnvelope({ id: "env-fail-1" });
      await deliver(mailbox, envelope);
      assert.equal(await claim(mailbox, envelope.id), true);
      await settle(mailbox, envelope.id, "failed", "任务单不存在");
      assert.equal((await locate(mailbox, envelope.id))?.state, "failed");
      const reason = await readFile(path.join(mailbox, "failed", `${envelope.id}.reason.txt`), "utf8");
      assert.match(reason, /任务单不存在/);
      const again = await deliver(mailbox, envelope);
      assert.equal(again.status, "duplicate");
    });
  });

  test("并发投递同一个 id 只有一封进信箱", async () => {
    await withRoot(async (root) => {
      const mailbox = path.join(root, "mailbox");
      const envelope = sampleEnvelope();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => deliver(mailbox, envelope)),
      );
      assert.equal(results.filter((item) => item.status === "accepted").length, 1);
      assert.equal(results.filter((item) => item.status === "duplicate").length, 7);
      const copies = (
        await Promise.all(
          (["new", "cur", "done", "failed"] as const).map((state) => locateIn(mailbox, state, envelope.id)),
        )
      ).filter(Boolean);
      assert.equal(copies.length, 1);
    });
  });

  test("seen 里还没改名进 new 的信可以补投", async () => {
    await withRoot(async (root) => {
      const mailbox = path.join(root, "mailbox");
      await ensureMailbox(mailbox);
      const envelope = sampleEnvelope();
      await writeFile(envelopePath(mailbox, "seen", envelope.id), serializeEnvelope(envelope));
      const ignored = await deliver(mailbox, envelope);
      assert.equal(ignored.status, "duplicate");
      assert.equal(await locate(mailbox, envelope.id), null);
      const repaired = await repairMailbox(mailbox);
      assert.equal(repaired, 1);
      assert.equal((await locate(mailbox, envelope.id))?.state, "new");
      const text = await readFile(envelopePath(mailbox, "new", envelope.id), "utf8");
      assert.equal(text, serializeEnvelope(envelope));
    });
  });

  test("非法信封不会落盘", async () => {
    await withRoot(async (root) => {
      const mailbox = path.join(root, "mailbox");
      await ensureMailbox(mailbox);
      const input = { ...sampleEnvelope(), type: "nudge" };
      await assert.rejects(
        () => deliver(mailbox, input),
        (err: unknown) => err instanceof ContractError && err.code === "invalid_envelope",
      );
      assert.deepEqual(await readdir(path.join(mailbox, "new")), []);
      assert.deepEqual(await readdir(path.join(mailbox, "seen")), []);
    });
  });
});

async function locateIn(mailbox: string, state: "new" | "cur" | "done" | "failed", id: string): Promise<boolean> {
  try {
    await stat(envelopePath(mailbox, state, id));
    return true;
  } catch {
    return false;
  }
}
