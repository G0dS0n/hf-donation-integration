# Heart Foundation - Donation Integration (Part 2: sample implementation)

A small, runnable integration service that takes website donation payloads, validates and
transforms them, and delivers them to a **simulated CRM** that behaves as described in
Documentation pack C - handling every response the CRM can return, and logging the outcome
of every donation.

## How to run

Requires **Node.js 18 or later**. No accounts, keys or external services are needed.

```bash
npm install
npm start            # the five payloads from the brief, then a reconciliation check
npm run scenarios    # replays the failures from the error log: 401, 429, 503, outage, replay
```

Both commands start the simulated CRM automatically on `localhost` and stop it at the end.
To run the CRM on its own (e.g. to call it with curl): `npm run crm` (port 4010).

## What happens to a donation

```
website payload
  → receive()   store it, duplicate check on donationId        (website would get 202 Accepted)
  → queue       one worker, so one shared rate limit (90/min, CRM allows 100)
  → validate    required fields, email format, amount > 0, payment approved
  → transform   amount ?? otherAmount → cents, fullName, UPPERCASE campaign, AUD, WEBSITE
  → send        POST /api/donors with a token that is refreshed before it expires
  → handle      201 delivered · 409 already exists = success · 400 → review queue
                401 → refresh token, retry once · 429 → wait Retry-After · 5xx → backoff, then dead-letter
  → log         one line per outcome (console + output/donations.log.jsonl), email masked
```

| File | Responsibility |
|---|---|
| `src/validate.ts` | Rejects bad data before it reaches the CRM |
| `src/transform.ts` | Website format → CRM format, safe dollars → cents |
| `src/tokenManager.ts` | OAuth client credentials; refreshes 5 min before expiry |
| `src/rateLimiter.ts` | Spaces requests to stay under the CRM limit |
| `src/crmClient.ts` | One HTTP call; reports status, field, Retry-After |
| `src/processor.ts` | Queue, idempotency, response handling, retries, review and dead-letter queues, recovery |
| `src/reconcile.ts` | Payment provider vs CRM by donation ID, count and $ total |
| `src/logger.ts` | Readable console log + structured JSON log, email masked |
| `src/mock-crm/server.ts` | Simulated CRM: token endpoint, validation, uniqueness, rate limit, injectable outages |

## Output: the five payloads (`npm start`)

```
  [09:14:56] payload 1 received (donation 12345)
✔ 12345  DELIVERED       CRM-88300 · $150.00 · APPEAL2026 · j***@email.com

  [09:15:02] payload 3 received (donation 12347)
✔ 12347  DELIVERED       CRM-88301 · $50.00 · APPEAL2026 · a***@email.com (Other amount used)

  [09:15:38] payload 2 received (donation 12345)
↺ 12345  DUPLICATE       already received - skipped, so no second receipt and no double-counting

  [09:41:11] payload 4 received (donation 12348)
✖ 12348  NEEDS_REVIEW    email "sam.lee@email" is not a valid address - sent to Supporter Care review queue

  [09:58:29] payload 5 received (donation 12350)
✔ 12350  DELIVERED       CRM-88302 · $80.00 · APPEAL2026 · p***@email.com

Summary
  Delivered to CRM (receipt sent): 3
  Duplicates prevented:            1
  Needs review (Supporter Care):   1
  Dead-letter (replay later):      0
  Silently lost:                   0

Reconciliation (payment provider vs CRM)
  Approved payments: 4  total $305.00
  Records in CRM:    3  total $280.00
  ⚠ ALERT: 12348 ($25.00) approved but not in CRM - known, waiting in review queue
```

| Payload | Donation | Result | Why |
|---|---|---|---|
| 1 | 12345 | Delivered | Valid; $150 → 15000 cents, `Appeal2026` → `APPEAL2026` |
| 2 | 12345 | Duplicate, skipped | Same donation resent 42 s later; no second receipt |
| 3 | 12347 | Delivered | `amount` null, so `otherAmount` "50.00" used → 5000 cents (the old service sent null and got a 400) |
| 4 | 12348 | Needs review | `sam.lee@email` has no domain; retrying can never fix it, so it goes to Supporter Care |
| 5 | 12350 | Delivered | Lowercase `appeal2026` normalised to `APPEAL2026` |

Payloads are processed in the order they were **received** (payload 3 arrived before payload 2).
Full output: [`output/run-output.txt`](output/run-output.txt). Structured log: [`output/run-log.jsonl`](output/run-log.jsonl).

## Output: the failures from the error log (`npm run scenarios`)

Times are shortened (a 3-second token instead of 60 minutes) so the demo runs in under a minute.
Full output: [`output/scenarios-output.txt`](output/scenarios-output.txt).

| Scenario | Old behaviour (log) | Now |
|---|---|---|
| Token expiry | 401 on the hour, donation lost (12352, 12371, 12384) | Token renewed before expiry; 0 lost |
| Token rejected unexpectedly | - | 401 → refresh → same donation retried and delivered |
| Campaign spike | 429 at 12:03, three lost (12390-12392) | Retry-After honoured; 20/20 delivered |
| CRM blip | 503, lost (12395) | Retried with backoff, delivered on attempt 3 |
| Longer outage | - | Dead-letter queue + alert, replayed when the CRM recovers |
| Replaying a donation already in the CRM | - | 409 treated as success; still one record, one receipt |

## Assumptions

- The website only sends donations the payment provider has **approved**; anything else is sent to review.
- `amount` (number) and `otherAmount` (string) are both dollar values; exactly one is used, `amount` first.
- `donationId` is unique per donation, so it is the idempotency key and the CRM `externalReference`.
- `submittedAt` is the donation date sent to the CRM (it is already ISO 8601 with the +10:00 offset).
- A `409` means the record already exists, i.e. the receipt has already been sent - so it is success, not an error.
- `400` errors are permanent: the same data will fail again, so they are never retried.
- Network errors and timeouts are treated like `503`: temporary, so retried.
- The 100/min CRM limit may be shared with other systems, so we send at 90/min.

## What I would change before production

1. **Durable storage and a managed queue** (e.g. SQS or Azure Service Bus) instead of in-memory, so nothing is lost on restart, with built-in dead-letter queues.
2. **Idempotency store in a database** (unique key on donationId) shared across instances.
3. **Secrets in a vault** (Key Vault / Secrets Manager) with rotation; no defaults in code.
4. **Signed requests from the website** (HMAC) so donations can't be forged.
5. **Alerting and dashboards** wired to the structured log (review / dead-letter items, 429 and 5xx rates, queue depth).
6. **Scheduled daily reconciliation** against the payment provider's API, hourly on campaign days.
7. **Shared or adaptive rate limiting** if more than one worker runs, and a circuit breaker for long outages.
8. **Fix at the source**: email validation and a double-submit guard on the website form; consider the payment provider's webhook as the source of truth.
9. **Data retention**: delete stored supporter details once delivery is confirmed.

## How I used AI

I used Claude Code as a pair programmer to scaffold the project, draft code and documentation, and
check edge cases. The design decisions, the root cause analysis and the final code were reviewed
and tested by me, and I can walk through any part of it.
