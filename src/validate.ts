/**
 * Check a website payload BEFORE it goes anywhere near the CRM.
 * Bad data can never succeed, so we catch it here instead of wasting a
 * CRM call (and a slot in the 100-per-minute rate limit).
 */
import type { WebsitePayload } from "./types.js";
import { resolveAmountCents } from "./transform.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // needs a domain with a dot: rejects "sam.lee@email"

export function validatePayload(p: WebsitePayload): string[] {
  const problems: string[] = [];

  if (!p.donationId || String(p.donationId).trim() === "") problems.push("donationId is missing");
  if (!p.firstName?.trim() || !p.lastName?.trim()) problems.push("first or last name is missing");
  if (!p.email || !EMAIL.test(p.email)) problems.push(`email "${p.email ?? ""}" is not a valid address`);
  if (p.paymentStatus !== "approved") problems.push(`paymentStatus is "${p.paymentStatus}", not approved`);
  if (!p.campaign?.trim()) problems.push("campaign is missing");
  if (!p.submittedAt || Number.isNaN(Date.parse(p.submittedAt))) problems.push("submittedAt is not a valid date");

  const cents = resolveAmountCents(p);
  if (cents === null || cents <= 0) problems.push("no valid amount (amount and otherAmount are both empty or not greater than 0)");

  return problems;
}
