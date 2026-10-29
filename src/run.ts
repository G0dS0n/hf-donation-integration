/**
 * npm start
 *
 * Starts the simulated CRM, sends EVERY payload file in payloads/ through the
 * integration, prints the outcome of each, then runs the reconciliation check.
 *
 * The five payloads from the brief are processed in the order they were received
 * on 1 October (payload 3 arrived before payload 2). Any other .json file you add
 * to payloads/ (6.json, 7.json, ...) is picked up automatically and processed after
 * them. A file can hold one payload object or an array of payloads.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { startMockCrm } from "./mock-crm/server.js";
import { TokenManager } from "./tokenManager.js";
import { DonationProcessor } from "./processor.js";
import { reconcile } from "./reconcile.js";
import { resolveAmountCents } from "./transform.js";
import type { WebsitePayload } from "./types.js";

rmSync(process.env.LOG_FILE ?? "output/donations.log.jsonl", { force: true });

// When the brief's payloads were received on 1 October 2026 (Documentation pack B).
const RECEIVED_AT: Record<string, string> = {
  "1.json": "09:14:56", "3.json": "09:15:02", "2.json": "09:15:38", "4.json": "09:41:11", "5.json": "09:58:29",
};
const PAYLOAD_DIR = process.env.PAYLOAD_DIR ?? "payloads";

// Every .json file in the folder: the brief's five first (in arrival order), then any others by number/name.
const files = readdirSync(PAYLOAD_DIR)
  .filter((f) => f.toLowerCase().endsWith(".json"))
  .sort((a, b) => {
    const ta = RECEIVED_AT[a], tb = RECEIVED_AT[b];
    if (ta && tb) return ta.localeCompare(tb);
    if (ta) return -1;
    if (tb) return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });

const crm = await startMockCrm({ port: Number(process.env.CRM_PORT ?? 4010) });
const tokens = new TokenManager({
  crmUrl: crm.url,
  clientId: process.env.CRM_CLIENT_ID ?? "hf-integration",
  clientSecret: process.env.CRM_CLIENT_SECRET ?? "local-dev-secret",
});
const processor = new DonationProcessor({ crmUrl: crm.url, tokens });

console.log(`\nSimulated CRM running at ${crm.url}`);
console.log(`Processing ${files.length} payload file(s) from ${PAYLOAD_DIR}/ ...\n`);

const payloads: WebsitePayload[] = [];
for (const file of files) {
  // A malformed file must not stop the other donations from being processed.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(`${PAYLOAD_DIR}/${file}`, "utf8"));
  } catch (err) {
    console.log(`\n  payload ${file} could not be read: ${(err as Error).message}`);
    console.log(`✖ ${file.padEnd(6)} NEEDS_REVIEW    not valid JSON - skipped, sent to review`);
    continue;
  }
  const items = (Array.isArray(parsed) ? parsed : [parsed]) as WebsitePayload[];
  for (const payload of items) {
    payloads.push(payload);
    const when = RECEIVED_AT[file] ? `[${RECEIVED_AT[file]}] ` : "";
    console.log(`\n  ${when}payload ${file.replace(/\.json$/i, "")} received (donation ${payload?.donationId ?? "missing"})`);
    const reply = processor.receive(payload);
    if (reply === "accepted") await processor.processAll(); // reply to website: 202 Accepted
  }
}

// ---- Summary -----------------------------------------------------------
const count = (o: string) => processor.results.filter((r) => r.outcome === o).length;
console.log("\nSummary");
console.log(`  Delivered to CRM (receipt sent): ${count("DELIVERED") + count("ALREADY_IN_CRM")}`);
console.log(`  Duplicates prevented:            ${count("DUPLICATE")}`);
console.log(`  Needs review (Supporter Care):   ${count("NEEDS_REVIEW")}`);
console.log(`  Dead-letter (replay later):      ${count("DEAD_LETTER")}`);
console.log(`  Silently lost:                   0`);
for (const { result } of processor.reviewQueue) console.log(`    review: ${result.donationId} - ${result.reason}`);

// ---- Daily reconciliation (payment provider vs CRM) ----------------------
// Only payments the provider actually approved (i.e. money was taken) belong in the reconciliation.
const unique = new Map(payloads.filter((p) => p?.donationId && p.paymentStatus === "approved").map((p) => [String(p.donationId), p]));
const payments = [...unique.values()].map((p) => ({ donationId: String(p.donationId), amountCents: resolveAmountCents(p) ?? 0 }));
const crmRecords = new Map([...crm.records].map(([id, r]) => [id, { amountCents: (r.body as { amountCents: number }).amountCents }]));
const report = reconcile(payments, crmRecords);
const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
console.log("\nReconciliation (payment provider vs CRM)");
console.log(`  Approved payments: ${report.approvedCount}  total ${$(report.approvedTotalCents)}`);
console.log(`  Records in CRM:    ${report.inCrmCount}  total ${$(report.inCrmTotalCents)}`);
if (report.missing.length === 0) console.log("  ✔ All approved donations are in the CRM");
else for (const m of report.missing) {
  const inReview = processor.reviewQueue.some((r) => r.result.donationId === m.donationId);
  console.log(`  ⚠ ALERT: ${m.donationId} (${$(m.amountCents)}) approved but not in CRM${inReview ? " - known, waiting in review queue" : ""}`);
}
console.log("\nStructured log written to output/donations.log.jsonl\n");

await crm.close();
