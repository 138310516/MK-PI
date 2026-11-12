import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ContractError } from "../src/errors.ts";
import { assertAcceptedKnowledge, parseTicket, renderArchive } from "../src/ticket.ts";
import { ticketMarkdown } from "./helpers.ts";

describe("任务单与存档", () => {
  test("解析目标、约束和输入", () => {
    const ticket = parseTicket(ticketMarkdown({ note: "NOTE-ONLY-IN-RESULT" }), "ticket.md");
    assert.equal(ticket.goal, "把首页标题改成「一人公司」");
    assert.deepEqual(ticket.constraints, ["只改标题文案", "不新增依赖"]);
    assert.equal(ticket.note, "NOTE-ONLY-IN-RESULT");
    assert.deepEqual(ticket.knowledge, []);
  });

  test("缺少目标时拒绝", () => {
    assert.throws(
      () => parseTicket("---\nconstraints:\n  - a\ninputs:\n  - b.md\n---\n", "ticket.md"),
      (err: unknown) => err instanceof ContractError && err.code === "bad_ticket",
    );
  });

  test("knowledge 只能指向 accepted", () => {
    assert.doesNotThrow(() =>
      assertAcceptedKnowledge("projects/site/knowledge/accepted/naming.md"),
    );
    assert.throws(
      () => assertAcceptedKnowledge("projects/site/knowledge/inbox/secret.md"),
      (err: unknown) => err instanceof ContractError && err.code === "bad_ticket",
    );
  });

  test("存档只有结论、产物和遗留", () => {
    for (const status of ["done", "blocked", "needs-review"] as const) {
      const text = renderArchive({
        taskId: "task-20261112-014",
        status,
        conclusion: "占位岗已按任务单完成，未调用模型。",
        artifact: "projects/site/agents/coder-ui/out/task-20261112-014/",
        leftover: "无",
      });
      assert.match(text, new RegExp(`status: ${status}`));
      const body = text.split("---").at(-1)?.trim() ?? "";
      assert.deepEqual(body.split("\n"), [
        "结论：占位岗已按任务单完成，未调用模型。",
        "产物：projects/site/agents/coder-ui/out/task-20261112-014/",
        "遗留：无",
      ]);
    }
  });
});
