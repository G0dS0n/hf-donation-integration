/**
 * One log line for every outcome and every retry.
 *
 * - Console: readable for people.
 * - output/donations.log.jsonl: structured (one JSON object per line), the format
 *   a monitoring tool such as Datadog or Azure Monitor would ingest and alert on.
 *
 * Privacy: we log the donationId and a MASKED email - never full supporter details.
 */
import { appendFileSync, mkdirSync } from "node:fs";

const LOG_FILE = process.env.LOG_FILE ?? "output/donations.log.jsonl";
mkdirSync("output", { recursive: true });

export function maskEmail(email?: string): string {
  if (!email) return "";
  const [user, domain] = email.split("@");
  return `${user?.charAt(0) ?? ""}***@${domain ?? ""}`;
}

const ICON: Record<string, string> = {
  DELIVERED: "✔", ALREADY_IN_CRM: "✔", DUPLICATE: "↺", NEEDS_REVIEW: "✖", DEAD_LETTER: "✖",
  RETRY: "…", TOKEN: "🔑", INFO: "•",
};

export function log(event: string, donationId: string, message: string, data: Record<string, unknown> = {}): void {
  const time = new Date().toISOString();
  const icon = ICON[event] ?? "•";
  console.log(`${icon} ${donationId.padEnd(6)} ${event.padEnd(15)} ${message}`);
  appendFileSync(LOG_FILE, JSON.stringify({ time, event, donationId, message, ...data }) + "\n");
}
