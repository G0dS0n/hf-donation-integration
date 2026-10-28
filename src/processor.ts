/**
 * The donation processor - steps 1 to 3 of the design diagram.
 *
 *   receive()     1. store the donation and check for duplicates (website gets "202 Accepted")
 *   processAll()  2. work through the queue one at a time (one worker = one shared rate limit)
 *   process()     3. validate -> transform -> send -> handle the CRM response
 *
 * Response handling (the yellow box in the diagram):
 *   201      delivered
 *   409      already in the CRM -> treated as success (it means the job is already done)
 *   400      bad data -> no retry, goes to the review queue for Supporter Care
 *   401      refresh the token and retry once
 *   429      wait for Retry-After, then retry
 *   5xx / network error  exponential backoff with jitter (1, 2, 4, 8 s...), then dead-letter
 */
import type { CrmDonor, Outcome, WebsitePayload } from "./types.js";
import { validatePayload } from "./validate.js";
import { toCrmDonor } from "./transform.js";
import { postDonor } from "./crmClient.js";
import { RateLimiter } from "./rateLimiter.js";
import type { TokenManager } from "./tokenManager.js";
import { log, maskEmail } from "./logger.js";

export interface ProcessorOptions {
  crmUrl: string;
  tokens: TokenManager;
  requestsPerMinute?: number;   // default 90 (CRM limit is 100)
  maxAttempts?: number;         // default 5
  backoffBaseMs?: number;       // default 1000 -> 1s, 2s, 4s, 8s
  maxRetryAfterSeconds?: number;
}

export interface DonationResult {
  donationId: string;
  outcome: Outcome;
  attempts: number;
  crmId?: string;
  amountCents?: number;
  reason?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dollars = (cents?: number) => (cents === undefined ? "" : `$${(cents / 100).toFixed(2)}`);

export class DonationProcessor {
  private queue: WebsitePayload[] = [];
  /** Idempotency store: every donationId we have accepted. Production: a database table with a unique key. */
  private accepted = new Set<string>();
  readonly results: DonationResult[] = [];
  readonly reviewQueue: { payload: WebsitePayload; result: DonationResult }[] = [];
  readonly deadLetter: { payload: WebsitePayload; result: DonationResult }[] = [];

  private limiter: RateLimiter;
  private maxAttempts: number;
  private backoffBaseMs: number;
  private maxRetryAfterSeconds: number;

  constructor(private opts: ProcessorOptions) {
    this.limiter = new RateLimiter(opts.requestsPerMinute ?? 90);
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.maxRetryAfterSeconds = opts.maxRetryAfterSeconds ?? 120;
  }

  /** Step 1 - receive and store. Returns what the website would be told. */
  receive(payload: WebsitePayload): "accepted" | "duplicate" {
    const id = String(payload.donationId ?? "");
    if (id && this.accepted.has(id)) {
      // e.g. payload 2: the website resent 12345 42 seconds later.
      const result: DonationResult = { donationId: id, outcome: "DUPLICATE", attempts: 0, reason: "already received" };
      this.results.push(result);
      log("DUPLICATE", id, "already received - skipped, so no second receipt and no double-counting");
      return "duplicate";
    }
    if (id) this.accepted.add(id);
    this.queue.push(payload); // production: write to a durable queue (SQS / Azure Service Bus)
    return "accepted";
  }

  /** Step 2 - one worker drains the queue, so the rate limit is shared by everything we send. */
  async processAll(): Promise<void> {
    while (this.queue.length > 0) {
      const payload = this.queue.shift()!;
      await this.process(payload);
    }
  }

  /** Replay dead-letter items once the CRM has recovered. Safe because of idempotency (409 = success). */
  async replayDeadLetters(): Promise<void> {
    const items = this.deadLetter.splice(0);
    for (const { payload } of items) {
      log("INFO", String(payload.donationId), "replaying from dead-letter queue");
      await this.process(payload);
    }
  }

  /**
   * Recovery: re-send a donation even though we have seen it before - e.g. the
   * donations missing since the start of the month. Safe because a 409 means
   * "already in the CRM" and is treated as success, so no second receipt.
   */
  async recover(payload: WebsitePayload): Promise<DonationResult> {
    log("INFO", String(payload.donationId), "recovery replay requested");
    return this.process(payload);
  }

  /** Step 3 - validate, transform, send, handle the response. */
  private async process(payload: WebsitePayload): Promise<DonationResult> {
    const id = String(payload.donationId);

    // 3a. Validate - bad data never reaches the CRM.
    const problems = validatePayload(payload);
    if (problems.length > 0) {
      return this.finish(payload, { donationId: id, outcome: "NEEDS_REVIEW", attempts: 0, reason: problems.join("; ") },
        `${problems.join("; ")} - sent to Supporter Care review queue`);
    }

    // 3b. Transform to the CRM format.
    const donor = toCrmDonor(payload);
    const usedOther = payload.amount === null && payload.otherAmount !== null ? " (Other amount used)" : "";

    // 3c. Send, with retries for temporary failures only.
    let triedFreshToken = false;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.limiter.acquire();
      const token = await this.opts.tokens.getToken();
      const res = await postDonor(this.opts.crmUrl, token, donor);
      const base = { donationId: id, attempts: attempt, amountCents: donor.amountCents };

      switch (res.status) {
        case 201:
          return this.finish(payload, { ...base, outcome: "DELIVERED", crmId: res.crmId },
            `${res.crmId} · ${dollars(donor.amountCents)} · ${donor.campaignCode} · ${maskEmail(donor.emailAddress)}${usedOther}`);

        case 409:
          return this.finish(payload, { ...base, outcome: "ALREADY_IN_CRM" },
            `already exists in CRM - treated as success, no duplicate receipt`);

        case 400:
          return this.finish(payload, { ...base, outcome: "NEEDS_REVIEW", reason: `CRM rejected ${res.field}: ${res.message}` },
            `CRM rejected field "${res.field}" (${res.message}) - no retry, sent to review queue`);

        case 401:
          if (!triedFreshToken) {
            triedFreshToken = true;
            this.opts.tokens.invalidate();
            log("RETRY", id, `401 token rejected - refreshing token and retrying once`, { attempt });
            continue;
          }
          return this.deadLetterResult(payload, donor, attempt, "401 again after a fresh token - check CRM credentials");

        case 429: {
          const wait = Math.min(res.retryAfterSeconds ?? 1, this.maxRetryAfterSeconds);
          log("RETRY", id, `429 CRM busy - waiting ${wait}s (Retry-After), then retrying`, { attempt });
          await sleep(wait * 1000);
          continue;
        }

        case 0:
        case 500:
        case 502:
        case 503:
        case 504: {
          if (attempt === this.maxAttempts) break;
          const delay = Math.round(this.backoffBaseMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4)); // jitter
          log("RETRY", id, `${res.status || "network error"} - CRM unavailable, retry ${attempt}/${this.maxAttempts - 1} in ${(delay / 1000).toFixed(1)}s`, { attempt });
          await sleep(delay);
          continue;
        }

        default:
          return this.deadLetterResult(payload, donor, attempt, `unexpected status ${res.status}`);
      }
    }
    return this.deadLetterResult(payload, donor, this.maxAttempts, "still failing after all retries - CRM unavailable");
  }

  private deadLetterResult(payload: WebsitePayload, donor: CrmDonor, attempts: number, reason: string): DonationResult {
    return this.finish(payload, { donationId: donor.externalReference, outcome: "DEAD_LETTER", attempts, amountCents: donor.amountCents, reason },
      `${reason} - moved to dead-letter queue, ALERT raised, will be replayed`);
  }

  private finish(payload: WebsitePayload, result: DonationResult, message: string): DonationResult {
    this.results.push(result);
    if (result.outcome === "NEEDS_REVIEW") this.reviewQueue.push({ payload, result });
    if (result.outcome === "DEAD_LETTER") this.deadLetter.push({ payload, result });
    log(result.outcome, result.donationId, message, { attempts: result.attempts, crmId: result.crmId, reason: result.reason });
    return result;
  }
}
