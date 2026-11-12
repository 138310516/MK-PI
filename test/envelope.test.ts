import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  compareEnvelopes,
  resultReadyId,
  validateEnvelope,
} from "../src/envelope.ts";
import { ContractError } from "../src/errors.ts";
import { sampleEnvelope } from "./helpers.ts";

describe("信封校验", () => {
  test("接受说明里的示例", () => {
    const envelope = validateEnvelope({
      id: "env-20261112-014-01",
      from: "clerk@home",
      to: "coder-ui@home",
      task_id: "task-20261112-014",
      type: "dispatch",
      priority: "normal",
      body: "projects/site/tickets/task-20261112-014.md",
      created_at: "2026-11-12T12:00:00+08:00",
    });
    assert.equal(envelope.type, "dispatch");
    assert.equal(envelope.body, "projects/site/tickets/task-20261112-014.md");
  });

  test("接受 result-ready、merge-ready 和 immediate", () => {
    for (const type of ["result-ready", "merge-ready"] as const) {
      const envelope = validateEnvelope(sampleEnvelope({ type, priority: "immediate" }));
      assert.equal(envelope.type, type);
      assert.equal(envelope.priority, "immediate");
    }
  });

  test("回执 id 由派单 id 决定", () => {
    assert.equal(resultReadyId("env-20261112-014-01"), "env-20261112-014-01--result-ready");
  });

  test("immediate 排在更早的 normal 前面", () => {
    const later = sampleEnvelope({
      id: "env-immediate",
      priority: "immediate",
      created_at: "2026-11-12T18:00:00Z",
    });
    const earlier = sampleEnvelope({
      id: "env-normal",
      priority: "normal",
      created_at: "2026-11-12T01:00:00Z",
    });
    assert.ok(compareEnvelopes(later, earlier) < 0);
  });

  const invalid: Array<{ name: string; patch: (input: Record<string, unknown>) => void }> = [
    { name: "缺少 id", patch: (input) => delete input.id },
    { name: "没有 nudge", patch: (input) => { input.type = "nudge"; } },
    { name: "优先级非法", patch: (input) => { input.priority = "urgent"; } },
    { name: "地址缺站点", patch: (input) => { input.from = "clerk"; } },
    { name: "地址大写", patch: (input) => { input.to = "Coder-ui@home"; } },
    { name: "绝对路径", patch: (input) => { input.body = "/etc/passwd"; } },
    { name: "路径跳出根目录", patch: (input) => { input.body = "projects/../secrets.md"; } },
    { name: "正文换行", patch: (input) => { input.body = "projects/site/tickets/a.md\n还有一段报告"; } },
    { name: "长报告", patch: (input) => { input.body = "这是一份长报告。不要放进信封。"; } },
    { name: "超长路径", patch: (input) => { input.body = `projects/${"a".repeat(520)}.md`; } },
    { name: "未知字段", patch: (input) => { input.note = "不要加字段"; } },
    { name: "时间不带时区", patch: (input) => { input.created_at = "2026-11-12T12:00:00"; } },
    { name: "id 有空格", patch: (input) => { input.id = "env 1"; } },
    { name: "task_id 有斜杠", patch: (input) => { input.task_id = "task/1"; } },
  ];

  for (const item of invalid) {
    test(`拒绝：${item.name}`, () => {
      const input: Record<string, unknown> = { ...sampleEnvelope() };
      item.patch(input);
      assert.throws(
        () => validateEnvelope(input),
        (err: unknown) => err instanceof ContractError && err.code === "invalid_envelope",
      );
    });
  }

  test("拒绝非对象", () => {
    assert.throws(() => validateEnvelope(null), ContractError);
    assert.throws(() => validateEnvelope(["dispatch"]), ContractError);
  });
});
