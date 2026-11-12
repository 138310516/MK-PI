import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resultReadyId, validateEnvelope } from "./envelope.ts";
import { ContractError } from "./errors.ts";
import { writeAtomic } from "./fsutil.ts";
import { deliver } from "./mailbox.ts";
import { agentDir, assertKnownAddress, mailboxDir, posixRelative, resolveProjectId } from "./paths.ts";
import { parseTicket, renderArchive, renderResult, resolveContainedFile } from "./ticket.ts";
import type { Company, DeliverResult, Envelope } from "./types.ts";

export interface DispatchOutcome {
  archiveRel: string;
  outRel: string;
  reply: Envelope;
  delivery: DeliverResult;
}

/**
 * 占位岗只读这一张任务单，写下 out/<task-id>/ 和短存档，再回 result-ready。
 * 回执的 body 是存档路径，不是报告正文。
 */
export async function executeDispatch(options: {
  root: string;
  company: Company;
  envelope: Envelope;
  projectId: string;
}): Promise<DispatchOutcome> {
  const { root, company, envelope, projectId } = options;
  const addressed = assertKnownAddress(company, envelope.to);
  if (addressed.role.kind !== "worker" && addressed.role.kind !== "merge") {
    throw new ContractError("not_executable", `${addressed.role.kind} 岗在 v0 不执行任务单`);
  }
  const bodyProject = resolveProjectId(company, envelope.body);
  if (bodyProject !== projectId) {
    throw new ContractError("misrouted", `任务属于项目 ${bodyProject}，信箱属于 ${projectId}`);
  }

  const replyId = resultReadyId(envelope.id);
  const ticketAbs = await resolveContainedFile(root, envelope.body, "任务单");
  const ticket = parseTicket(await readFile(ticketAbs, "utf8"), envelope.body);
  for (const rel of ticket.knowledge) {
    await resolveContainedFile(root, rel, "知识");
  }

  const home = agentDir(root, projectId, addressed.role.id);
  const outDir = path.join(home, "out", envelope.task_id);
  const archiveFile = path.join(home, "archive", `${envelope.task_id}.md`);
  const reviewed = ticket.knowledge.length > 0;
  await mkdir(outDir, { recursive: true });
  await mkdir(path.dirname(archiveFile), { recursive: true });
  await writeAtomic(
    path.join(outDir, "result.md"),
    renderResult({ taskId: envelope.task_id, role: envelope.to, ticket }),
  );
  const archiveRel = posixRelative(root, archiveFile);
  const outRel = `${posixRelative(root, outDir)}/`;
  await writeAtomic(
    archiveFile,
    renderArchive({
      taskId: envelope.task_id,
      status: reviewed ? "needs-review" : "done",
      conclusion: reviewed
        ? "占位岗已写下产物，知识库未核对。"
        : "占位岗已按任务单完成，未调用模型。",
      artifact: outRel,
      leftover: reviewed ? "知识未核对" : "无",
    }),
  );

  const reply = validateEnvelope({
    id: replyId,
    from: envelope.to,
    to: envelope.from,
    task_id: envelope.task_id,
    type: "result-ready",
    priority: envelope.priority,
    body: archiveRel,
    created_at: new Date().toISOString(),
  });
  const delivery = await deliver(mailboxDir(root, company, reply.to, reply.body), reply);
  return { archiveRel, outRel, reply, delivery };
}
