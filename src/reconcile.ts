/**
 * Daily reconciliation: compare what the payment provider charged with what
 * the CRM holds, by donationId, count and dollar total.
 *
 * This is the check that would have told Finance on 2 October that nine
 * donations ($510) were missing, instead of hearing it from supporters.
 */
export interface Payment { donationId: string; amountCents: number }

export interface ReconciliationReport {
  approvedCount: number;
  approvedTotalCents: number;
  inCrmCount: number;
  inCrmTotalCents: number;
  missing: Payment[];
}

export function reconcile(payments: Payment[], crmRecords: Map<string, { amountCents: number }>): ReconciliationReport {
  const missing = payments.filter((p) => !crmRecords.has(p.donationId));
  const found = payments.filter((p) => crmRecords.has(p.donationId));
  return {
    approvedCount: payments.length,
    approvedTotalCents: payments.reduce((s, p) => s + p.amountCents, 0),
    inCrmCount: found.length,
    inCrmTotalCents: found.reduce((s, p) => s + (crmRecords.get(p.donationId)?.amountCents ?? 0), 0),
    missing,
  };
}
