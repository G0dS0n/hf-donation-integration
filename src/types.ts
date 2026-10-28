/** What the website sends us (Documentation pack B). */
export interface WebsitePayload {
  donationId: string;
  firstName: string;
  lastName: string;
  email: string;
  amount: number | null;
  otherAmount: string | number | null;
  campaign: string;
  paymentStatus: string;
  submittedAt: string;
}

/** What the CRM expects (Documentation pack C). */
export interface CrmDonor {
  externalReference: string;
  fullName: string;
  emailAddress: string;
  amountCents: number;
  currency: "AUD";
  campaignCode: string;
  sourceSystem: "WEBSITE";
  donationDate: string;
}

/** The final outcome recorded for every donation. */
export type Outcome =
  | "DELIVERED"       // 201 - record created, CRM sends the receipt
  | "ALREADY_IN_CRM"  // 409 - already there, treated as success
  | "DUPLICATE"       // same donationId received again - skipped, no second receipt
  | "NEEDS_REVIEW"    // bad data (our validation or CRM 400) - no retry, goes to Supporter Care
  | "DEAD_LETTER";    // temporary errors that outlasted all retries - replay later
