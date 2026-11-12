import path from "node:path";
import { clerkRole } from "./company.ts";
import { ContractError } from "./errors.ts";
import type { Company, Role } from "./types.ts";

const ADDRESS_RE = /^([a-z0-9][a-z0-9-]{0,63})@([a-z0-9][a-z0-9-]{0,63})$/;

export interface Address {
  role: string;
  site: string;
}

/** 监视时绑定到具体信箱，避免把信按错项目执行。 */
export interface MailboxBinding {
  mailbox: string;
  role: Role;
  projectId?: string;
}

export function parseAddress(address: string): Address {
  const match = ADDRESS_RE.exec(address);
  if (!match || !match[1] || !match[2]) {
    throw new ContractError("invalid_address", `地址格式应为 role@site：${address}`);
  }
  return { role: match[1], site: match[2] };
}

export function assertKnownAddress(company: Company, address: string): { role: Role; site: string } {
  const parsed = parseAddress(address);
  if (!company.sites.some((site) => site.id === parsed.site)) {
    throw new ContractError("unknown_site", `未知站点 ${parsed.site}`);
  }
  const role = company.roles.find((item) => item.id === parsed.role);
  if (!role) {
    throw new ContractError("unknown_role", `未知岗位 ${parsed.role}`);
  }
  return { role, site: parsed.site };
}

/**
 * 多个项目时，从 body 的 `projects/<id>/` 前缀判断。
 * 只有一个项目时，可以省略前缀。
 */
export function resolveProjectId(company: Company, body: string): string {
  const match = /^projects\/([^/]+)\//.exec(body);
  if (match?.[1]) {
    if (!company.projects.some((project) => project.id === match[1])) {
      throw new ContractError("unknown_project", `未知项目 ${match[1]}`);
    }
    return match[1];
  }
  if (company.projects.length === 1 && company.projects[0]) {
    return company.projects[0].id;
  }
  throw new ContractError(
    "unknown_project",
    "多个项目时，body 必须以 projects/<项目 id>/ 开头",
  );
}

/** `clerk@site` 进公司根的 clerk 信箱；其他岗位进对应项目的 agents 信箱。 */
export function mailboxDir(root: string, company: Company, address: string, body?: string): string {
  const { role } = assertKnownAddress(company, address);
  if (role.kind === "clerk") {
    if (role.id !== clerkRole(company).id) {
      throw new ContractError("bad_company", "传话岗不唯一");
    }
    return path.join(root, "clerk", "mailbox");
  }
  const projectId = resolveProjectId(company, body ?? "");
  return path.join(root, "projects", projectId, "agents", role.id, "mailbox");
}

export function agentDir(root: string, projectId: string, roleId: string): string {
  return path.join(root, "projects", projectId, "agents", roleId);
}

export function watchBindings(root: string, company: Company, roleId?: string): MailboxBinding[] {
  const roles = roleId ? company.roles.filter((role) => role.id === roleId) : company.roles;
  if (roleId && roles.length === 0) {
    throw new ContractError("unknown_role", `未知岗位 ${roleId}`);
  }
  const bindings: MailboxBinding[] = [];
  for (const role of roles) {
    if (role.kind === "clerk") {
      bindings.push({ mailbox: path.join(root, "clerk", "mailbox"), role });
      for (const project of company.projects) {
        bindings.push({
          mailbox: path.join(root, "projects", project.id, "clerk", "mailbox"),
          role,
          projectId: project.id,
        });
      }
      continue;
    }
    for (const project of company.projects) {
      bindings.push({
        mailbox: path.join(root, "projects", project.id, "agents", role.id, "mailbox"),
        role,
        projectId: project.id,
      });
    }
  }
  return bindings;
}

export function posixRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}
