export const ROLE_KINDS = ["clerk", "knowledge", "worker", "merge"] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export const ENVELOPE_TYPES = ["dispatch", "result-ready", "merge-ready"] as const;
export type EnvelopeType = (typeof ENVELOPE_TYPES)[number];

export const PRIORITIES = ["immediate", "normal"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ARCHIVE_STATUSES = ["done", "blocked", "needs-review"] as const;
export type ArchiveStatus = (typeof ARCHIVE_STATUSES)[number];

/** 信在信箱里的位置。tmp 是落盘草稿，seen 是 id 台账，都不算在途状态。 */
export const MAIL_STATES = ["new", "cur", "done", "failed"] as const;
export type MailState = (typeof MAIL_STATES)[number];

export interface Role {
  id: string;
  kind: RoleKind;
}

export interface NamedId {
  id: string;
}

export interface Company {
  company: string;
  sites: NamedId[];
  roles: Role[];
  projects: NamedId[];
}

/** 信封。body 只能是文件路径，不能塞长报告。 */
export interface Envelope {
  id: string;
  from: string;
  to: string;
  task_id: string;
  type: EnvelopeType;
  priority: Priority;
  body: string;
  created_at: string;
}

export interface DeliverResult {
  status: "accepted" | "duplicate";
  file: string;
}

export interface Ticket {
  goal: string;
  constraints: string[];
  inputs: string[];
  knowledge: string[];
  /** YAML 头之后的正文，占位岗只取第一行写进产物。 */
  note: string;
}
