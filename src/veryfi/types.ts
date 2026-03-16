/** Veryfi API type definitions — ported from Python client analysis.
 *
 * Based on corpus analysis of 455 receipts across the internal API
 * (iapi.veryfi.com/api/v7). See ../../../veryfi/c-d-veryfi-knowledge-transfer/
 * for the full field inventory and data quality findings.
 */

// ── Configuration ───────────────────────────────────────────────────

export interface VeryfiConfig {
  username: string;
  password: string;
  totpSecret: string;
  baseUrl: string;         // default: https://iapi.veryfi.com/api/v7
  maxPageSize: number;     // default: 200 (server accepts up to ~500)
  rateLimitRps: number;    // default: 1.0
}

// ── Auth ────────────────────────────────────────────────────────────

export interface VeryfiCredentials {
  clientId: string;        // constant across sessions
  veryfiSession: string;   // changes every login, ~60-90 min lifetime
  cookies: string;         // accumulated cookies from auth flow
  authenticatedAt: number; // Date.now() when auth completed
}

// ── Pagination ──────────────────────────────────────────────────────

export interface VeryfiMeta {
  documents_per_page: number;
  page_number: number;
  pagination_type: string;
  total_money_in: number;
  total_money_out: number;
  total_pages: number;
  total_results: number;
}

// ── Receipt ─────────────────────────────────────────────────────────

export interface VeryfiCategory {
  id: number;
  name: string;
  code?: string;
  type?: string;
  monthly_budget?: number;
}

export interface VeryfiPayment {
  id: number;
  name?: string;
  logo?: string;
  provider?: string;
  number?: string;
  created?: string;
  ca_purchase_account?: string;
}

export interface VeryfiTaxLine {
  id: number;
  base?: number;
  code?: string;
  name: string;
  order?: number;
  rate?: number;
  tax_rate_id?: number;
}

export interface VeryfiUser {
  id: number;
  avatar?: string;
  color?: string;
  email: string;
  full_name: string;
}

export interface VerfyiBankTransaction {
  id: number;
  amount?: number;
  bank_account?: {
    institution_name?: string;
    logo_url?: string;
  };
}

export interface VeryfiLineItem {
  id: number;
  order: number;
  description: string;         // 96% populated, often ALL CAPS
  quantity: number;            // usually 1.0; fractional for fuel (gallons), weight (lbs)
  price: number;               // zero 84% of the time — prefer `total`
  total: number;               // line item total amount
  discount: number;
  tax: number;                 // always 0 — tax only at receipt level
  tax_rate: number;            // always 0
  type?: string;               // food (71%), product (17%), fuel (6%), fee, discount
  sku?: string;                // 42% populated, all-numeric 5-12 digits
  upc?: string;                // 1% populated, 12-digit UPC barcode
  section?: string;            // 15% — GROCERY, PRODUCE, KITCHEN
  unit_of_measure?: string;    // 11% — gal, lb, etc.
  category?: VeryfiCategory;   // 6% — per-item category override
  tags?: string[];             // always empty []
  date?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  hsn?: string | null;
  reference?: string | null;
  weight?: number | null;
  cost_code?: Record<string, unknown>;
  customer?: Record<string, unknown>;
  project?: Record<string, unknown>;
}

export interface VeryfiReceipt {
  id: number;
  receipt_id: number;          // always equals id (redundant)

  // Vendor
  business_name: string;       // 131 unique but inconsistent by OCR
  business_id: number | null;  // reliable dedup key (199 unique), mixed int/str in API
  store_number?: string;       // 79% populated

  // Amounts (floats in API, NOT cents)
  total: number;
  subtotal: number;
  tax: number;
  tip: number;
  discount: number;
  shipping: number;

  // Dates
  stamp_date: string;          // receipt date from OCR: "2026-02-23 15:46:20"
  created: string;             // upload timestamp: "2026-03-08 21:06:20"
  taken?: string;              // ISO format with T separator
  date: string | null;         // always null — use stamp_date

  // Status / type
  status: string;              // processed, reviewed, archived
  document_type: string;       // receipt or invoice
  accounting_entry_type: string; // debit or credit
  source: string;              // lens.receipt, scan, email, web, bank_transaction
  currency_code: string;

  // Reference numbers
  invoice_number?: string;
  reference_number?: string;

  // Notes
  notes?: string;              // 3% populated
  ocr_text?: string;           // raw OCR text

  // Flags
  is_dupe: number;             // 0/1
  is_paid: number;             // 0/1, 87% paid
  is_reconciled: number;       // 0/1, 30% reconciled

  // Address
  business_full_address?: string;  // contains \n
  formatted_address?: string;      // Google-formatted, 42%
  business_lat?: number | null;    // mixed float/str in API
  business_lng?: number | null;

  // Images
  img?: string;                // signed CDN URL
  pdf?: string;                // signed CDN URL

  // Line items
  line_items: VeryfiLineItem[];
  line_items_count?: number;   // list endpoint only

  // Nested objects
  category?: VeryfiCategory;   // 90% populated
  payment?: VeryfiPayment;     // 88% populated
  user?: VeryfiUser;
  bank_transaction?: VerfyiBankTransaction; // 30% populated
  tax_lines?: VeryfiTaxLine[];             // 16% populated
  duplicate_of?: { id: number; reference_number: string };
  meta?: { documents: Record<string, unknown>[] };
  currency?: { code: string; name: string; symbol: string };

  // Catch-all for remaining fields
  [key: string]: unknown;
}

// ── Receipt query filters ───────────────────────────────────────────

export interface VeryfiReceiptFilters {
  startDate?: string;         // YYYY-MM-DD
  endDate?: string;           // YYYY-MM-DD
  dateType?: string;          // created | stamp_date (default: created)
  tag?: string;               // singular! exact match, case-sensitive
  status?: string;            // comma-separated: processed,reviewed,archived
  vendor?: string;            // case-insensitive partial match
  q?: string;                 // full-text search
  category?: string;          // exact category name, case-sensitive
  documentType?: string;      // receipt | invoice
  accountingEntryType?: string; // debit | credit
  orderby?: string;           // created, stamp_date, total (prefix - for desc)
  pageSize?: number;          // default 50, server accepts up to ~500
  maxPages?: number;          // stop after N pages (undefined = all)
}

// ── Tags ────────────────────────────────────────────────────────────

export interface VeryfiTag {
  id: number;
  name: string;
  receipts_count: number;     // can be stale
  spent?: number;
  status?: string;
}
