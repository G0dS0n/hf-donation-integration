/**
 * One HTTP call to the CRM. Deliberately simple: it reports what happened,
 * and the processor decides what to do about it.
 */
import type { CrmDonor } from "./types.js";

export interface CrmResponse {
  status: number;              // 201, 400, 401, 409, 429, 500, 503 - or 0 for a network error
  crmId?: string;
  field?: string;              // which field failed validation (400)
  message?: string;
  retryAfterSeconds?: number;  // from the Retry-After header (429)
}

export async function postDonor(crmUrl: string, token: string, donor: CrmDonor): Promise<CrmResponse> {
  try {
    const res = await fetch(`${crmUrl}/api/donors`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(donor),
      signal: AbortSignal.timeout(10_000), // never hang forever on a slow CRM
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    const retryAfter = res.headers.get("retry-after");
    return {
      status: res.status,
      crmId: body.crmId,
      field: body.field,
      message: body.message ?? body.error,
      retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined,
    };
  } catch (err) {
    // Timeouts and connection failures are treated like a 503: temporary, so retry.
    return { status: 0, message: (err as Error).message };
  }
}
