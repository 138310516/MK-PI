import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import {
  DEFAULT_COMPANY,
  companyDirectories,
  initCompany,
  loadCompany,
  parseCompany,
} from "../src/company.ts";
import { ContractError } from "../src/errors.ts";
import { mailboxDir } from "../src/paths.ts";
import { withRoot } from "./helpers.ts";

describe("opc init 与路由", () => {
  test("生成 company.yaml 和约定目录", async () => {
    await withRoot(async (root) => {
      const company = await initCompany(root);
      assert.equal(company.company, "example");
      assert.deepEqual(await loadCompany(root), company);
      const required = [
        "clerk/mailbox/tmp",
        "clerk/mailbox/new",
        "clerk/mailbox/cur",
        "clerk/mailbox/done",
        "clerk/mailbox/failed",
        "clerk/out",
        "clerk/archive",
        "projects/site/clerk/mailbox/new",
        "projects/site/knowledge/inbox",
        "projects/site/knowledge/accepted",
        "projects/site/knowledge/rejected",
        "projects/site/tickets",
        "projects/site/agents/coder-ui/workdir",
        "projects/site/agents/coder-ui/mailbox/tmp",
        "projects/site/agents/coder-ui/mailbox/new",
        "projects/site/agents/coder-ui/mailbox/cur",
        "projects/site/agents/coder-ui/mailbox/done",
        "projects/site/agents/coder-ui/mailbox/failed",
        "projects/site/agents/coder-ui/out",
        "projects/site/agents/coder-ui/archive",
        "projects/site/agents/knowledge/mailbox/new",
        "projects/site/agents/merge/mailbox/new",
      ];
      const layout = companyDirectories(DEFAULT_COMPANY);
      for (const rel of required) {
        assert.ok(layout.includes(rel), rel);
        await access(path.join(root, rel));
      }
      assert.equal(layout.some((rel) => rel.includes("agents/clerk")), false);
    });
  });

  test("重复 init 会拒绝覆盖", async () => {
    await withRoot(async (root) => {
      await initCompany(root);
      await assert.rejects(
        () => initCompany(root),
        (err: unknown) => err instanceof ContractError && err.code === "already_initialized",
      );
    });
  });

  test("不接受 lead 这种岗位", () => {
    assert.throws(
      () =>
        parseCompany({
          company: "example",
          sites: [{ id: "home" }],
          roles: [{ id: "lead", kind: "lead" }],
          projects: [{ id: "site" }],
        }),
      (err: unknown) => err instanceof ContractError && err.code === "bad_company",
    );
  });

  test("clerk 进公司信箱，执行岗进项目 agents", () => {
    const root = "/company";
    assert.equal(
      mailboxDir(root, DEFAULT_COMPANY, "clerk@home"),
      path.join(root, "clerk", "mailbox"),
    );
    assert.equal(
      mailboxDir(root, DEFAULT_COMPANY, "coder-ui@home", "projects/site/tickets/a.md"),
      path.join(root, "projects", "site", "agents", "coder-ui", "mailbox"),
    );
  });

  test("多个项目时必须能从 body 判断项目", () => {
    const company = parseCompany({
      company: "example",
      sites: [{ id: "home" }],
      roles: [
        { id: "clerk", kind: "clerk" },
        { id: "coder-ui", kind: "worker" },
      ],
      projects: [{ id: "site" }, { id: "api" }],
    });
    assert.throws(
      () => mailboxDir("/company", company, "coder-ui@home", "notes/a.md"),
      (err: unknown) => err instanceof ContractError && err.code === "unknown_project",
    );
    assert.equal(
      mailboxDir("/company", company, "coder-ui@home", "projects/api/tickets/a.md"),
      path.join("/company", "projects", "api", "agents", "coder-ui", "mailbox"),
    );
  });
});
