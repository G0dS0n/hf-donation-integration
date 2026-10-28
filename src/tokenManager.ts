/**
 * Manages the CRM access token (OAuth 2.0 client credentials).
 *
 * Old behaviour: the token was only refreshed AFTER a request failed with 401,
 * and that request was never retried - one donation lost every hour, on the hour
 * (12352 at 10:00, 12371 at 11:00, 12384 at 12:01).
 *
 * New behaviour: refresh BEFORE expiry (default 5 minutes early). `invalidate()`
 * exists for the rare case the CRM still says 401 - the processor then refreshes
 * and retries once.
 */
export interface TokenManagerOptions {
  crmUrl: string;
  clientId: string;
  clientSecret: string;   // production: read from a secrets vault, never hard-coded
  refreshEarlyMs?: number;
}

export class TokenManager {
  private token: string | null = null;
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null; // one refresh shared by all callers
  public refreshCount = 0;

  constructor(private opts: TokenManagerOptions) {}

  async getToken(): Promise<string> {
    const refreshEarlyMs = this.opts.refreshEarlyMs ?? 5 * 60 * 1000;
    
    if (this.token && Date.now() < this.expiresAt - refreshEarlyMs) return this.token;
    if (!this.inFlight) this.inFlight = this.refresh().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  /** Called after an unexpected 401: forget the token so the next call fetches a new one. */
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  private async refresh(): Promise<string> {
    const res = await fetch(`${this.opts.crmUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Token request failed with ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = body.access_token;
    this.expiresAt = Date.now() + body.expires_in * 1000;
    this.refreshCount++;
    return this.token;
  }
}
