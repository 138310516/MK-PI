import { ContractError } from "./errors.ts";
import {
  ENVELOPE_TYPES,
  PRIORITIES,
  type Envelope,
  type EnvelopeType,
  type Priority,
} from "./types.ts";

/** 信封 id 同时是文件名，所以只允许安全字符。回执 id 会再接 `--result-ready`。 */
export const MAX_ID_LENGTH = 160;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ADDRESS_RE = /^[a-z0-9][a-z0-9-]{0,63}@[a-z0-9][a-z0-9-]{0,63}$/;
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SEGMENT_RE = /^[A-Za-z0-9_@.+-]+$/;

const FIELDS = [
  "id",
  "from",
  "to",
  "task_id",
  "type",
  "priority",
  "body",
  "created_at",
] as const;

export function isEnvelopeId(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_ID_LENGTH && ID_RE.test(value);
}

/** body 必须是公司根内的相对路径，不能是一段报告。 */
export function isRelativeBodyPath(body: string): boolean {
  if (body.length < 1 || body.length > 512) return false;
  if (body.includes("\\") || body.includes("\0")) return false;
  const parts = body.split("/");
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (part === "." || part === "..") return false;
    if (!SEGMENT_RE.test(part)) return false;
  }
  const last = parts[parts.length - 1];
  if (!last) return false;
  return parts.length >= 2 || last.includes(".");
}

export function resultReadyId(dispatchId: string): string {
  const id = `${dispatchId}--result-ready`;
  if (!isEnvelopeId(id)) {
    const limit = MAX_ID_LENGTH - "--result-ready".length;
    throw new ContractError(
      "invalid_envelope",
      `派单 id 过长，无法生成回执 id（请控制在 ${limit} 个字符以内）`,
    );
  }
  return id;
}

export function validateEnvelope(input: unknown): Envelope {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractError("invalid_envelope", "信封必须是 JSON 对象");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FIELDS.includes(key as (typeof FIELDS)[number])) {
      throw new ContractError("invalid_envelope", `未知字段 ${key}`);
    }
  }

  const id = requireId(record, "id");
  const from = requireAddress(record, "from");
  const to = requireAddress(record, "to");
  const taskId = requireId(record, "task_id");
  const type = requireEnum(record, "type", ENVELOPE_TYPES, "dispatch、result-ready、merge-ready");
  const priority = requireEnum(record, "priority", PRIORITIES, "immediate、normal");
  const body = requireBody(record);
  const createdAt = requireTimestamp(record);

  return {
    id,
    from,
    to,
    task_id: taskId,
    type,
    priority,
    body,
    created_at: createdAt,
  };
}

export function serializeEnvelope(envelope: Envelope): string {
  const ordered = {
    id: envelope.id,
    from: envelope.from,
    to: envelope.to,
    task_id: envelope.task_id,
    type: envelope.type,
    priority: envelope.priority,
    body: envelope.body,
    created_at: envelope.created_at,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** immediate 先于 normal，然后按时间，再按 id。 */
export function compareEnvelopes(a: Envelope, b: Envelope): number {
  const rank = (priority: Priority): number => (priority === "immediate" ? 0 : 1);
  const byPriority = rank(a.priority) - rank(b.priority);
  if (byPriority !== 0) return byPriority;
  const byTime = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (byTime !== 0) return byTime;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function requireId(record: Record<string, unknown>, field: "id" | "task_id"): string {
  const value = requireString(record, field);
  if (!isEnvelopeId(value)) {
    throw new ContractError(
      "invalid_envelope",
      `${field} 只能是字母数字和 ._-，长度 1–${MAX_ID_LENGTH}：${value}`,
    );
  }
  return value;
}

function requireAddress(record: Record<string, unknown>, field: "from" | "to"): string {
  const value = requireString(record, field);
  if (!ADDRESS_RE.test(value)) {
    throw new ContractError("invalid_envelope", `${field} 必须是 role@site：${value}`);
  }
  return value;
}

function requireBody(record: Record<string, unknown>): string {
  const value = requireString(record, "body");
  if (!isRelativeBodyPath(value)) {
    throw new ContractError(
      "invalid_envelope",
      "body 只能是公司根内的相对文件路径，不能把报告写进信封",
    );
  }
  return value;
}

function requireTimestamp(record: Record<string, unknown>): string {
  const value = requireString(record, "created_at");
  if (!TIMESTAMP_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ContractError(
      "invalid_envelope",
      `created_at 必须是带时区的 ISO 8601 时间：${value}`,
    );
  }
  return value;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractError("invalid_envelope", `缺少或非法字段 ${field}`);
  }
  return value;
}

function requireEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  label: string,
): T {
  const value = requireString(record, field);
  if (!allowed.includes(value as T)) {
    throw new ContractError("invalid_envelope", `${field} 只能是 ${label}`);
  }
  return value as T;
}

export function isEnvelopeType(value: string): value is EnvelopeType {
  return ENVELOPE_TYPES.includes(value as EnvelopeType);
}
