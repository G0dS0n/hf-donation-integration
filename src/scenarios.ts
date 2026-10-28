/**
 * npm run scenarios
 *
 * Replays the failures from the 1 October error log (Documentation pack D)
 * against the simulated CRM, to show each one is now handled. Times are
 * shortened (seconds instead of an hour) so the demo runs in under a minute.
 */
import { rmSync } from "node:fs";
import { startMockCrm } from "./mock-crm/server.js";
import { TokenManager } from "./tokenManager.js";
import { DonationProcessor } from "./processor.js";
import type { WebsitePayload } from "./types.js";

rmSync(process.env.LOG_FILE ?? "output/donations.log.jsonl", { force: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextId = 12400;
const donation = (amount = 35): WebsitePayload => ({
  donationId: String(nextId++),
  firstName: "Test",
  lastName: "Supporter",
  email: "supporter@email.com",
  amount,
  otherAmount: null,
  campaign: "Appeal2026",
  paymentStatus: "approved",
  submittedAt: new Date().toISOString(),
});
let failures = 0;
/** Every result line is worked out from what actually happened - nothing is assumed. */
const check = (passed: boolean, text: string) => {
  if (!passed) failures++;
  console.log(`\n${passed ? "PASS" : "FAIL"} → ${text}`);
};
const lost = (p: DonationProcessor) =>
  p.results.filter(
    (r) => r.outcome === "DEAD_LETTER" || r.outcome === "NEEDS_REVIEW",
  ).length;
const heading = (t: string) =>
  console.log(`\n=== ${t} ${"=".repeat(Math.max(0, 70 - t.length))}`);

async function setup(
  port: number,
  crmOpts: Parameters<typeof startMockCrm>[0] = { port },
  tokenEarlyMs = 5 * 60 * 1000,
  procOpts: Partial<ConstructorParameters<typeof DonationProcessor>[0]> = {},
) {
  const crm = await startMockCrm({ ...crmOpts, port });
  const tokens = new TokenManager({
    crmUrl: crm.url,
    clientId: "hf-integration",
    clientSecret: "local-dev-secret",
    refreshEarlyMs: tokenEarlyMs,
  });
  const processor = new DonationProcessor({
    crmUrl: crm.url,
    tokens,
    backoffBaseMs: 300,
    ...procOpts,
  });
  return { crm, tokens, processor };
}

// 1. Token expiry ------------------------------------------------------------
heading(
  "1. Token expiry  (log: 401 at 10:00, 11:00 and 12:01 - 12352, 12371, 12384 lost)",
);
console.log(
  "CRM token lasts 3s here (60 min in real life). We refresh 1s before expiry.\n",
);
{
  const { crm, tokens, processor } = await setup(
    4021,
    { port: 4021, tokenTtlSeconds: 3 },
    1000,
  );
  for (let i = 0; i < 3; i++) {
    processor.receive(donation());
    await processor.processAll();
    await sleep(1500);
  }
  const retried401 = processor.results.some((r) => r.attempts > 1);
  check(
    crm.records.size === 3 && !retried401,
    `${crm.records.size}/3 delivered first time, ${tokens.refreshCount} token refreshes, no 401s - the token was renewed BEFORE it expired.`,
  );
  await crm.close();
}

heading("1b. Safety net: CRM rejects a token unexpectedly (e.g. revoked)");
{
  const { crm, tokens, processor } = await setup(4022);
  processor.receive(donation());
  await processor.processAll();
  crm.revokeTokens(); // the CRM stops accepting our cached token
  processor.receive(donation());
  await processor.processAll();
  const second = processor.results[1];
  check(
    second?.outcome === "DELIVERED" &&
      second.attempts === 2 &&
      tokens.refreshCount === 2,
    `401 handled: donation ${second?.donationId} ${second?.outcome} on attempt ${second?.attempts} after a token refresh (${tokens.refreshCount} tokens issued).`,
  );
  await crm.close();
}

// 2. Campaign spike ------------------------------------------------------------
heading("2. Campaign spike  (log: 429 at 12:03 - 12390, 12391, 12392 lost)");
console.log(
  "CRM allows 10 requests per 3s here. 20 donations arrive at once and our limiter is switched",
);
console.log(
  "off to force the CRM to push back - showing Retry-After is honoured.\n",
);
{
  const { crm, processor } = await setup(
    4023,
    { port: 4023, rateLimit: 10, rateWindowSeconds: 3 },
    undefined,
    { requestsPerMinute: 0 },
  );
  for (let i = 0; i < 20; i++) processor.receive(donation(10 + i));
  await processor.processAll();
  const delivered = processor.results.filter(
    (r) => r.outcome === "DELIVERED",
  ).length;
  const waited = processor.results.filter((r) => r.attempts > 1).length;
  check(
    delivered === 20 && crm.records.size === 20 && lost(processor) === 0,
    `${delivered}/20 delivered, ${waited} had to wait out a 429 first, ${lost(processor)} lost.`,
  );
  console.log(
    "  In normal running the 90/min limiter stops the CRM limit being hit; Retry-After is the safety net.",
  );
  await crm.close();
}

// 3. CRM outage ----------------------------------------------------------------
heading("3. CRM temporarily unavailable  (log: 503 at 12:03:14 - 12395 lost)");
{
  const { crm, processor } = await setup(4024);
  crm.failNext(503, 2);
  processor.receive(donation(40));
  await processor.processAll();
  const r3 = processor.results[0];
  check(
    r3?.outcome === "DELIVERED" && r3.attempts === 3,
    `two 503s retried with exponential backoff: ${r3?.outcome} on attempt ${r3?.attempts}.`,
  );
  await crm.close();
}

heading(
  "3b. Longer outage: retries used up -> dead-letter -> replay when CRM recovers",
);
{
  const { crm, processor } = await setup(4025);
  crm.failNext(503, 5);
  processor.receive(donation(60));
  await processor.processAll();
  console.log(
    `\n   Dead-letter queue now holds ${processor.deadLetter.length} donation. CRM recovers...`,
  );
  await processor.replayDeadLetters();
  const final = processor.results[processor.results.length - 1];
  check(
    processor.results[0]?.outcome === "DEAD_LETTER" &&
      final?.outcome === "DELIVERED" &&
      crm.records.size === 1,
    `dead-lettered after ${processor.results[0]?.attempts} attempts, then replayed: ${final?.outcome}. Nothing dropped.`,
  );
  await crm.close();
}

// 4. Replay safety -----------------------------------------------------------------
heading("4. Replay is safe  (idempotency: 409 = already done)");
{
  const { crm, processor } = await setup(4026);
  const d = donation(100);
  processor.receive(d);
  await processor.processAll();
  // Recovering a donation that was in fact already created (e.g. its response timed out).
  await processor.recover(d);
  const replay = processor.results[processor.results.length - 1];
  check(
    replay?.outcome === "ALREADY_IN_CRM" && crm.records.size === 1,
    `replay returned ${replay?.outcome}; CRM still holds ${crm.records.size} record for ${d.donationId}, so no second receipt.`,
  );
  await crm.close();
}

console.log(
  `\n${failures === 0 ? "All scenarios passed" : `${failures} scenario(s) FAILED`}. Structured log: output/donations.log.jsonl\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
