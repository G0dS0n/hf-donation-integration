/**
 * Simulated CRM - behaves as described in Documentation pack C.
 *
 *   POST /oauth/token   -> access token (valid 60 min by default)
 *   POST /api/donors    -> 201 | 400 | 401 | 409 | 429 | 500 | 503
 *
 * Settings can be shortened (token lifetime, rate-limit window) so the
 * failure scenarios can be demonstrated in seconds instead of hours.
 */
import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";

export interface MockCrmOptions {
  port: number;
  tokenTtlSeconds?: number;   // spec: 3600 (60 minutes)
  rateLimit?: number;         // spec: 100 requests...
  rateWindowSeconds?: number; // ...per 60 seconds
  clientId?: string;
  clientSecret?: string;
}

export interface MockCrm {
  url: string;
  /** Make the next `count` donor requests fail with this status (500 or 503). */
  failNext(status: 500 | 503, count?: number): void;
  /** Invalidate every issued token early (simulates a revoked or rotated credential). */
  revokeTokens(): void;
  /** Records the CRM holds, keyed by externalReference. */
  records: Map<string, { crmId: string; body: unknown }>;
  close(): Promise<void>;
}

const REQUIRED = [
  "externalReference", "fullName", "emailAddress", "amountCents",
  "currency", "campaignCode", "sourceSystem", "donationDate",
] as const;

export function startMockCrm(opts: MockCrmOptions): Promise<MockCrm> {
  const tokenTtlMs = (opts.tokenTtlSeconds ?? 3600) * 1000;
  const rateLimit = opts.rateLimit ?? 100;
  const windowMs = (opts.rateWindowSeconds ?? 60) * 1000;
  const clientId = opts.clientId ?? "hf-integration";
  const clientSecret = opts.clientSecret ?? "local-dev-secret";

  const tokens = new Map<string, number>();          // token -> expiry time
  const records = new Map<string, { crmId: string; body: unknown }>();
  let requestTimes: number[] = [];                   // for the rate limit
  const injectedFailures: Array<500 | 503> = [];
  let nextCrmId = 88300;

  const app = express();
  app.use(express.json());

  // --- Authentication: OAuth 2.0 client credentials ---------------------
  app.post("/oauth/token", (req: Request, res: Response) => {
    const { grant_type, client_id, client_secret } = req.body ?? {};
    if (grant_type !== "client_credentials" || client_id !== clientId || client_secret !== clientSecret) {
      return res.status(401).json({ error: "invalid_client" });
    }
    const token = randomUUID();
    tokens.set(token, Date.now() + tokenTtlMs);
    res.json({ access_token: token, token_type: "Bearer", expires_in: tokenTtlMs / 1000 });
  });

  // --- Create donor ------------------------------------------------------
  app.post("/api/donors", (req: Request, res: Response) => {
    // 1. Rate limit (sliding window)
    const now = Date.now();
    requestTimes = requestTimes.filter((t) => now - t < windowMs);
    if (requestTimes.length >= rateLimit) {
      const retryAfter = Math.ceil((windowMs - (now - requestTimes[0])) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Too Many Requests" });
    }
    requestTimes.push(now);

    // 2. Authentication
    const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const expiry = tokens.get(token);
    if (!expiry || expiry <= now) {
      return res.status(401).json({ error: "Authentication token expired" });
    }

    // 3. Injected outage (to demonstrate 500 / 503 handling)
    const failure = injectedFailures.shift();
    if (failure) {
      return res.status(failure).json({ error: failure === 503 ? "Service Unavailable" : "Internal Server Error" });
    }

    // 4. Validation (rules from the CRM spec)
    const body = req.body ?? {};
    for (const field of REQUIRED) {
      if (body[field] === undefined || body[field] === null || body[field] === "") {
        return res.status(400).json({ error: "Validation failed", field, message: "required" });
      }
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.emailAddress)) {
      return res.status(400).json({ error: "Validation failed", field: "emailAddress", message: "invalid format" });
    }
    if (!Number.isInteger(body.amountCents) || body.amountCents <= 0) {
      return res.status(400).json({ error: "Validation failed", field: "amountCents", message: "must be an integer greater than 0" });
    }
    if (body.currency !== "AUD") {
      return res.status(400).json({ error: "Validation failed", field: "currency", message: "must be AUD" });
    }
    if (body.campaignCode !== String(body.campaignCode).toUpperCase()) {
      return res.status(400).json({ error: "Validation failed", field: "campaignCode", message: "must be uppercase" });
    }
    if (body.sourceSystem !== "WEBSITE") {
      return res.status(400).json({ error: "Validation failed", field: "sourceSystem", message: "must be WEBSITE" });
    }
    if (Number.isNaN(Date.parse(body.donationDate))) {
      return res.status(400).json({ error: "Validation failed", field: "donationDate", message: "must be ISO 8601" });
    }

    // 5. Uniqueness of externalReference
    if (records.has(body.externalReference)) {
      return res.status(409).json({ error: "externalReference already exists" });
    }

    // 6. Created - the real CRM emails the receipt at this point
    const crmId = `CRM-${nextCrmId++}`;
    records.set(body.externalReference, { crmId, body });
    res.status(201).json({ crmId });
  });

  return new Promise((resolve) => {
    const server: Server = app.listen(opts.port, () => {
      resolve({
        url: `http://localhost:${opts.port}`,
        failNext(status, count = 1) {
          for (let i = 0; i < count; i++) injectedFailures.push(status);
        },
        revokeTokens() { tokens.clear(); },
        records,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
