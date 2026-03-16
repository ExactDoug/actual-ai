// Receipt integration types — normalized across all OCR providers.
// All monetary amounts are integers in cents (Actual Budget convention).

export interface ReceiptLineItem {
  description: string;
  quantity: number;
  unitPrice: number;           // cents
  totalPrice: number;          // cents (quantity * unitPrice, or provider total)
  category?: string;           // provider's category guess (if any)
  taxable?: boolean | null;    // true, false, or null (unknown)
}

export interface ReceiptDocument {
  externalId: string;          // provider-specific ID (e.g., Veryfi document id)
  providerId: string;          // e.g., "veryfi"
  vendorName: string;
  vendorId?: string;           // provider's vendor/business ID for dedup
  date: string;                // YYYY-MM-DD (OCR date from receipt)
  currency: string;
  totalAmount: number;         // cents
  subtotalAmount: number;      // cents
  taxAmount: number;           // cents
  tipAmount: number;           // cents
  discountAmount: number;      // cents
  shippingAmount: number;      // cents
  lineItems: ReceiptLineItem[];
  rawData: unknown;            // full provider response for debugging
  imageUrl?: string;           // provider's receipt image URL
}

export type MatchConfidence = 'exact' | 'probable' | 'possible' | 'manual';

export type MatchStatus = 'pending' | 'classified' | 'approved' | 'applied' | 'rejected';

export interface ReceiptMatch {
  id: string;
  transactionId: string;
  receiptId: string;
  matchConfidence: MatchConfidence;
  matchedAt: string;           // ISO 8601
  status: MatchStatus;
  preSplitSnapshot?: string;   // original transaction JSON before split
}

export interface ReceiptMatchHistory {
  id: string;
  receiptId: string;
  oldTransactionId: string | null;
  newTransactionId: string | null;
  action: 'match' | 'unmatch' | 'rematch';
  oldMatchConfidence: MatchConfidence | null;
  newMatchConfidence: MatchConfidence | null;
  reason?: string;
  performedAt: string;         // ISO 8601
  performedBy: string;         // 'system' | 'user'
}

export type LineItemClassificationStatus = 'pending' | 'approved' | 'rejected';

export interface LineItemClassification {
  id: string;
  receiptMatchId: string;
  lineItemIndex: number;
  description: string;
  quantity: number;
  unitPrice: number;           // cents
  totalPrice: number;          // cents
  taxable: boolean | null;
  allocatedTax: number;        // cents
  amountWithTax: number;       // cents
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
  classificationType: string | null; // existing, new, rule, fallback
  confidence: string | null;   // high, medium, low
  status: LineItemClassificationStatus;
  notes: string | null;
}

export interface SplitEntry {
  amount: number;              // cents, negative for expenses
  categoryId: string;
  notes: string;
}

export interface SplitPlan {
  transactionId: string;
  splits: SplitEntry[];
}

export interface ReceiptConnector {
  readonly providerId: string;
  fetchReceipts(since: Date): Promise<{
    receipts: ReceiptDocument[];
    errors: Array<{ message: string; context?: unknown }>;
  }>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
}
