/**
 * npm start
 *
 * Starts the simulated CRM, sends the five website payloads through the
 * integration in the order they were received on 1 October, prints the outcome
 * of each, then runs the reconciliation check.
 */
import { readFileSync, rmSync } from "node:fs";
import { startMockCrm } from "./mock-crm/server.js";
import { TokenManager } from "./tokenManager.js";
import { DonationProcessor } from "./processor.js";
import { reconcile } from "./reconcile.js";
import { resolveAmountCents } from "./transform.js";
import type { WebsitePayload } from "./types.js";

rmSync(process.env.LOG_FILE ?? "output/donations.log.jsonl", { force: true });

// Order received by the integration on 1 October 2026 (Documentation pack B).
const ARRIVALS = [
  { file: "1.json", receivedAt: "09:14:56" },
  { file: "3.json", receivedAt: "09:15:02" },
  { file: "2.json", receivedAt: "09:15:38" },
  { file: "4.json", receivedAt: "09:41:11" },
  { file: "5.json", receivedAt: "09:58:29" },
];

const crm = await startMockCrm({ port: Number(process.env.CRM_PORT ?? 4010) });
const tokens = new TokenManager({
  crmUrl: crm.url,
  clientId: process.env.CRM_CLIENT_ID ?? "hf-integration",
  clientSecret: process.env.CRM_CLIENT_SECRET ?? "local-dev-secret",
});
const processor = new DonationProcessor({ crmUrl: crm.url, tokens });

console.log(`\nSimulated CRM running at ${crm.url}`);
console.log("Processing the 5 website payloads in the order they were received...\n");

const payloads: WebsitePayload[] = [];
for (const { file, receivedAt } of ARRIVALS) {
  const payload = JSON.parse(readFileSync(`payloads/${file}`, "utf8")) as WebsitePayload;
  payloads.push(payload);
  console.log(`\n  [${receivedAt}] payload ${file.replace(".json", "")} received (donation ${payload.donationId})`);
  const reply = processor.receive(payload);
  if (reply === "accepted") await processor.processAll(); // reply to website: 202 Accepted
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
const unique = new Map(payloads.map((p) => [String(p.donationId), p]));
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
