import { loadCompany } from "./company.ts";
import { validateEnvelope } from "./envelope.ts";
import { deliver } from "./mailbox.ts";
import { assertKnownAddress, mailboxDir } from "./paths.ts";
import type { DeliverResult, Envelope } from "./types.ts";

export async function sendEnvelope(
  root: string,
  input: unknown,
): Promise<DeliverResult & { envelope: Envelope }> {
  const company = await loadCompany(root);
  const envelope = validateEnvelope(input);
  assertKnownAddress(company, envelope.from);
  assertKnownAddress(company, envelope.to);
  const result = await deliver(mailboxDir(root, company, envelope.to, envelope.body), envelope);
  return { ...result, envelope };
}
