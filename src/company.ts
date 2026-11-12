import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { ContractError } from "./errors.ts";
import { errno } from "./fsutil.ts";
import { ROLE_KINDS, type Company, type NamedId, type Role, type RoleKind } from "./types.ts";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAILBOX_PARTS = ["tmp", "new", "cur", "done", "failed", "seen"] as const;

export const DEFAULT_COMPANY: Company = {
  company: "example",
  sites: [{ id: "home" }],
  roles: [
    { id: "clerk", kind: "clerk" },
    { id: "knowledge", kind: "knowledge" },
    { id: "merge", kind: "merge" },
    { id: "coder-ui", kind: "worker" },
  ],
  projects: [{ id: "site" }],
};

export function companyFile(root: string): string {
  return path.join(root, "company.yaml");
}

export function companyToYaml(company: Company): string {
  return `# 一人公司 v0\n${stringify(company)}`;
}

export function parseCompany(input: unknown): Company {
  if (!isRecord(input)) {
    throw new ContractError("bad_company", "company.yaml 必须是映射");
  }
  const keys = Object.keys(input);
  for (const key of keys) {
    if (!["company", "sites", "roles", "projects"].includes(key)) {
      throw new ContractError("bad_company", `company.yaml 有未知字段 ${key}`);
    }
  }

  const company = requireName(input.company, "company");
  const sites = requireIdList(input.sites, "sites");
  const projects = requireIdList(input.projects, "projects");
  const roles = requireRoles(input.roles);
  if (sites.length === 0) {
    throw new ContractError("bad_company", "至少要有一个站点");
  }
  const clerks = roles.filter((role) => role.kind === "clerk");
  if (clerks.length !== 1) {
    throw new ContractError("bad_company", "v0 需要且只需要一个 kind: clerk 的岗位");
  }
  uniqueIds(sites.map((site) => site.id), "站点");
  uniqueIds(projects.map((project) => project.id), "项目");
  uniqueIds(roles.map((role) => role.id), "岗位");

  return { company, sites, roles, projects };
}

/** init 要创建的相对目录。信箱一律带 tmp/new/cur/done/failed/seen。 */
export function companyDirectories(company: Company): string[] {
  const dirs = [
    ...mailboxDirs("clerk"),
    "clerk/out",
    "clerk/archive",
  ];
  for (const project of company.projects) {
    const base = `projects/${project.id}`;
    dirs.push(
      ...mailboxDirs(`${base}/clerk`),
      `${base}/clerk/out`,
      `${base}/clerk/archive`,
      `${base}/knowledge/inbox`,
      `${base}/knowledge/accepted`,
      `${base}/knowledge/rejected`,
      `${base}/tickets`,
    );
    for (const role of company.roles) {
      if (role.kind === "clerk") continue;
      const agent = `${base}/agents/${role.id}`;
      dirs.push(
        `${agent}/workdir`,
        ...mailboxDirs(agent),
        `${agent}/out`,
        `${agent}/archive`,
      );
    }
  }
  return dirs;
}

export async function loadCompany(root: string): Promise<Company> {
  const file = companyFile(root);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (errno(err) === "ENOENT") {
      throw new ContractError("bad_company", `找不到 ${file}，请先运行 opc init`);
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ContractError("bad_company", `无法解析 company.yaml：${detail}`);
  }
  return parseCompany(raw);
}

export async function initCompany(
  root: string,
  options?: { force?: boolean; company?: Company },
): Promise<Company> {
  const company = parseCompany(options?.company ?? DEFAULT_COMPANY);
  const abs = path.resolve(root);
  await mkdir(abs, { recursive: true });
  const file = companyFile(abs);
  const yaml = companyToYaml(company);
  if (options?.force) {
    await writeFile(file, yaml);
  } else {
    try {
      await writeFile(file, yaml, { flag: "wx" });
    } catch (err) {
      if (errno(err) === "EEXIST") {
        throw new ContractError("already_initialized", `已存在 ${file}，如需覆盖请加 --force`);
      }
      throw err;
    }
  }
  for (const rel of companyDirectories(company)) {
    await mkdir(path.join(abs, rel), { recursive: true });
  }
  return company;
}

export function clerkRole(company: Company): Role {
  const role = company.roles.find((item) => item.kind === "clerk");
  if (!role) {
    throw new ContractError("bad_company", "缺少传话岗");
  }
  return role;
}

function mailboxDirs(prefix: string): string[] {
  return MAILBOX_PARTS.map((part) => `${prefix}/mailbox/${part}`);
}

function requireRoles(input: unknown): Role[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ContractError("bad_company", "roles 必须是非空列表");
  }
  return input.map((item, index) => {
    if (!isRecord(item)) {
      throw new ContractError("bad_company", `roles[${index}] 必须是映射`);
    }
    for (const key of Object.keys(item)) {
      if (key !== "id" && key !== "kind") {
        throw new ContractError("bad_company", `roles[${index}] 有未知字段 ${key}`);
      }
    }
    const id = requireToken(item.id, `roles[${index}].id`);
    const kind = item.kind;
    if (typeof kind !== "string" || !ROLE_KINDS.includes(kind as RoleKind)) {
      throw new ContractError(
        "bad_company",
        `roles[${index}].kind 只能是 clerk、knowledge、worker、merge`,
      );
    }
    return { id, kind: kind as RoleKind };
  });
}

function requireIdList(input: unknown, field: string): NamedId[] {
  if (!Array.isArray(input)) {
    throw new ContractError("bad_company", `${field} 必须是列表`);
  }
  return input.map((item, index) => {
    if (!isRecord(item)) {
      throw new ContractError("bad_company", `${field}[${index}] 必须是映射`);
    }
    for (const key of Object.keys(item)) {
      if (key !== "id") {
        throw new ContractError("bad_company", `${field}[${index}] 有未知字段 ${key}`);
      }
    }
    return { id: requireToken(item.id, `${field}[${index}].id`) };
  });
}

function requireName(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim() === "" || input.length > 80 || /[\r\n]/.test(input)) {
    throw new ContractError("bad_company", `${field} 必须是单行非空字符串`);
  }
  return input.trim();
}

function requireToken(input: unknown, field: string): string {
  if (typeof input !== "string" || !ID_RE.test(input)) {
    throw new ContractError("bad_company", `${field} 必须是小写 role/site/项目 id`);
  }
  return input;
}

function uniqueIds(ids: string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new ContractError("bad_company", `重复的${label} ${id}`);
    }
    seen.add(id);
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input);
}
