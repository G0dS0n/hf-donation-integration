/**
 * Convert the website format into the CRM format (Documentation pack C).
 */
import type { CrmDonor, WebsitePayload } from "./types.js";

/**
 * The donor picks a preset amount (`amount`) OR types their own (`otherAmount`).
 * The old service only read `amount`, so every "Other amount" donation (e.g. 12347)
 * was sent with amount = null and rejected by the CRM.
 *
 * Dollars are converted to whole cents without floating-point maths:
 * "50.00" -> 5000, 150 -> 15000.
 */
export function resolveAmountCents(p: Pick<WebsitePayload, "amount" | "otherAmount">): number | null {
  const raw = p.amount ?? p.otherAmount;
  if (raw === null || raw === undefined || raw === "") return null;

  const text = typeof raw === "number" ? raw.toFixed(2) : String(raw).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null; // e.g. "abc", "-5", "1.999"

  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "0").padEnd(2, "0"));
  return dollars * 100 + cents;
}

export function toCrmDonor(p: WebsitePayload): CrmDonor {
  return {
    externalReference: String(p.donationId),               // idempotency key - must be unique in the CRM
    fullName: `${p.firstName.trim()} ${p.lastName.trim()}`,
    emailAddress: p.email.trim().toLowerCase(),
    amountCents: resolveAmountCents(p)!,                    // validated before we get here
    currency: "AUD",
    campaignCode: p.campaign.trim().toUpperCase(),          // "appeal2026" -> "APPEAL2026"
    sourceSystem: "WEBSITE",
    donationDate: p.submittedAt,                            // already ISO 8601 with timezone
  };
}
