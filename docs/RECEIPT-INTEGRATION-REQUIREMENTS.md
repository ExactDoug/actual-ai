# Receipt/OCR Integration & Line-Item Classification

## 1. Overview

Extend actual-ai to integrate with receipt scanning / OCR services, match
scanned receipts to bank transactions in Actual Budget, and classify each
line-item on a receipt to the appropriate budget category. When receipt data
is available, line-item classification overrides the existing generalized
best-effort AI categorization with higher-accuracy per-item splits.

The integration is designed as a **generic receipt connector** — Veryfi.co is
the first provider, but the architecture supports any receipt/OCR service that
can supply structured line-item data.

## 2. Goals

1. **Match** transactions in Actual Budget with receipts from connected OCR
   services (by amount, date, merchant, or manual association).
2. **Classify every line-item** on a matched receipt using the same category
   resolution pipeline actual-ai already uses (AI analysis, web search, Actual
   Budget rules), extended for individual items rather than whole transactions.
3. **Create split transactions** in Actual Budget so each line-item gets its
   own category allocation.
4. **Handle sales tax** intelligently — spread proportionately across items,
   respecting taxable vs. non-taxable designations when present.
5. **Fall back gracefully** — when a line-item can't be confidently classified
   on its own, use the existing whole-transaction classification approach for
   that item.
6. **Support multiple OCR providers** through a pluggable connector interface.

## 3. Architecture

### 3.1 Receipt Connector Interface

A generic interface that any OCR provider adapter must implement:

```typescript
interface ReceiptConnector {
  /** Unique provider identifier (e.g., "veryfi", "taggun", "mindee") */
  readonly providerId: string;

  /** Human-readable provider name */
  readonly providerName: string;

  /**
   * Fetch receipts/documents within a date range.
   * Returns normalized ReceiptDocument objects.
   *
   * Partial failures (some receipts fail to parse) should be logged and
   * skipped — return the successfully parsed receipts and report errors
   * via the errors array in the result.
   */
  fetchReceipts(dateFrom: string, dateTo: string): Promise<{
    receipts: ReceiptDocument[];
    errors: { externalId?: string; message: string }[];
  }>;

  /**
   * Fetch a single receipt by its provider-specific ID.
   * Returns null if the receipt does not exist (404).
   * Throws on network/auth errors (caller should retry or re-auth).
   */
  getReceipt(externalId: string): Promise<ReceiptDocument | null>;

  /**
   * Test connectivity and authentication with the provider.
   */
  testConnection(): Promise<{ ok: boolean; message: string }>;
}
```

### 3.2 Normalized Receipt Data Model

All provider adapters normalize their responses into this common structure.

**Amount convention:** All amounts in the normalized model are **integers in
cents**. Provider adapters must convert from the provider's native format
(e.g., Veryfi uses floats in dollars). Use `Math.round(dollarAmount * 100)`
to avoid floating-point precision errors (e.g., `32.91 * 100 = 3290.999...`).

```typescript
interface ReceiptDocument {
  /** Provider-specific document ID */
  externalId: string;

  /** Which connector produced this (e.g., "veryfi") */
  providerId: string;

  /** Vendor/merchant name as recognized by OCR */
  vendorName: string;

  /** Provider-specific vendor/business ID for deduplication.
   *  More reliable than vendorName for matching (OCR produces
   *  inconsistent names for the same business). */
  vendorId?: string;

  /** Total amount in cents (integer, positive).
   *  This is the receipt's stated total — do NOT recalculate from
   *  subtotal + tax + tip, as 46% of Veryfi receipts fail that equation
   *  due to independent OCR extraction of each field. */
  totalAmount: number;

  /** Transaction date (YYYY-MM-DD).
   *  Use the receipt/purchase date (Veryfi: stamp_date), NOT the
   *  upload/created date. */
  date: string;

  /** Currency code (e.g., "USD") */
  currency: string;

  /** Individual line items. May be empty (6% of Veryfi receipts have
   *  0 line items due to OCR failure). */
  lineItems: ReceiptLineItem[];

  /** Tax information */
  tax: ReceiptTax;

  /** Optional: tips, discounts, shipping, etc. */
  additionalCharges: ReceiptAdditionalCharge[];

  /** Raw OCR text (for debugging / fallback analysis) */
  ocrText?: string;

  /** URL to receipt image in the provider's system.
   *  May be a time-limited signed URL — UI should handle 403/404
   *  gracefully if the URL has expired. */
  imageUrl?: string;

  /** Provider-specific metadata (preserved for reference) */
  providerMeta?: Record<string, unknown>;
}

interface ReceiptLineItem {
  /** Line-item description as recognized by OCR */
  description: string;

  /** Quantity (default 1). May be fractional for fuel (gallons),
   *  produce (weight in lbs), etc. */
  quantity: number;

  /** Unit price in cents. CAUTION: Veryfi's line_items[].price is zero
   *  on 84% of items. The adapter should derive unitPrice from
   *  totalPrice / quantity when the source price field is zero. */
  unitPrice: number;

  /** Total price for this line in cents.
   *  This is the canonical per-item amount — always use this over
   *  unitPrice * quantity, which may not reconcile (e.g., produce
   *  sold by weight where quantity is rounded). */
  totalPrice: number;

  /** SKU or product code, if recognized */
  sku?: string;

  /** Whether this item is taxable. null = unknown.
   *  Veryfi does not have a boolean taxable field — the adapter
   *  cannot reliably infer taxability from line-item data because
   *  line-item tax is always 0 in Veryfi. Default to null (unknown)
   *  and let tax allocation treat all items as taxable. */
  taxable?: boolean | null;

  /** Provider-specific category/type guess (informational).
   *  Veryfi values: food, product, fuel, fee, discount. Only 6% of
   *  items have a per-item category override — do not rely on this. */
  providerCategory?: string;
}

interface ReceiptTax {
  /** Total tax amount in cents */
  totalTax: number;

  /** Individual tax line items (e.g., state tax, county tax) */
  taxLines?: { name: string; amount: number; rate?: number }[];
}

interface ReceiptAdditionalCharge {
  type: 'tip' | 'discount' | 'shipping' | 'fee' | 'other';
  description: string;
  amount: number; // cents, positive value
}
```

### 3.3 Veryfi Adapter (First Implementation)

The first concrete adapter implements `ReceiptConnector` for Veryfi.co.
Uses the internal API client (`src/veryfi/`) which authenticates via the
browser login flow (username + password + TOTP MFA).

```typescript
class VeryfiConnector implements ReceiptConnector {
  readonly providerId = 'veryfi';
  readonly providerName = 'Veryfi';

  constructor(
    private username: string,
    private password: string,
    private totpSecret: string,
  ) {}

  // Maps Veryfi's document JSON → ReceiptDocument
  // Maps Veryfi's line_items[] → ReceiptLineItem[]
  // Maps Veryfi's tax field → ReceiptTax
}
```

**Veryfi API fields mapped to ReceiptDocument:**

| Veryfi Field | ReceiptDocument Field | Conversion Notes |
|---|---|---|
| `id` | `externalId` | Cast to string |
| `business_name` | `vendorName` | Inconsistent OCR names (131 unique for 199 businesses) |
| `business_id` | `vendorId` | Reliable dedup key; cast to string (mixed int/str in API) |
| `total` | `totalAmount` | `Math.round(total * 100)` — dollars to cents |
| `stamp_date` | `date` | Extract YYYY-MM-DD from "YYYY-MM-DD HH:MM:SS". NOT `date` (always null) or `created` (upload timestamp) |
| `currency_code` | `currency` | |
| `line_items[].description` | `lineItems[].description` | 96% populated, often ALL CAPS |
| `line_items[].quantity` | `lineItems[].quantity` | May be fractional (fuel gallons, produce weight) |
| `line_items[].total` | `lineItems[].totalPrice` | `Math.round(total * 100)`. This is the canonical amount — NOT price |
| `line_items[].total / quantity` | `lineItems[].unitPrice` | Derived. Do NOT use `line_items[].price` (zero on 84% of items) |
| `line_items[].sku` | `lineItems[].sku` | 42% populated |
| *(not available)* | `lineItems[].taxable` | Always set to `null` — Veryfi line-item `tax` is always 0 |
| `line_items[].type` | `lineItems[].providerCategory` | food (71%), product (17%), fuel (6%) |
| `tax` | `tax.totalTax` | `Math.round(tax * 100)` |
| `tax_lines` | `tax.taxLines` | Only 16% populated |
| `tip` | `additionalCharges` (type: tip) | Only non-zero on 17/455 receipts |
| `discount` | `additionalCharges` (type: discount) | Only non-zero on 37/455 receipts |
| `shipping` | `additionalCharges` (type: shipping) | Always 0 in corpus — include for completeness |
| `ocr_text` | `ocrText` | |
| `img` | `imageUrl` | Signed CDN URL, may expire |

**Veryfi data quality notes (from 455-receipt corpus analysis):**
- **46% of receipts** fail `total ≠ subtotal + tax + tip - discount + shipping`.
  Do NOT recalculate total — use the stated `total` as canonical.
- **4 receipts** have `total: $0.00` — handle gracefully, do not skip.
- **8% of receipts** have `sum(line_items[].total) ≠ subtotal` — do NOT
  use line items to derive the receipt subtotal.
- **28 receipts (6%)** have 0 line items — skip line-item classification,
  fall back to whole-transaction classification.
- Vendor names are inconsistent across OCR runs (e.g., `7-2-11`, `7-2-11
  FOOD STORE`, `7-2-11!` are the same business). Use `business_id` for
  vendor deduplication.
- `stamp_date` can be 30+ days before `created` (batch uploads of old
  receipts). Maximum gap in corpus: 723 days. This is expected.

### 3.4 Component Diagram

```
┌──────────────────────────────────────────────────────────┐
│                      actual-ai                           │
│                                                          │
│  ┌──────────────────┐   ┌────────────────────────────┐   │
│  │ TransactionService│   │  ReceiptMatchingService    │   │
│  │ (existing)       │◄──│  - matchReceipts()         │   │
│  │                  │   │  - resolveLineItems()      │   │
│  └────────┬─────────┘   └────────────┬───────────────┘   │
│           │                          │                   │
│           │              ┌───────────▼──────────────┐    │
│           │              │ ReceiptConnectorRegistry  │    │
│           │              │ - register(connector)     │    │
│           │              │ - getConnector(providerId) │    │
│           │              └───────────┬──────────────┘    │
│           │                          │                   │
│           │              ┌───────────▼──────────────┐    │
│           │              │   ReceiptConnector        │    │
│           │              │   (interface)             │    │
│           │              └───┬───────────────┬──────┘    │
│           │                  │               │           │
│           │          ┌───────▼───┐   ┌───────▼───┐       │
│           │          │  Veryfi   │   │  Future   │       │
│           │          │  Adapter  │   │  Adapter  │       │
│           │          └───────────┘   └──────────┘        │
│           │                                              │
│  ┌────────▼─────────┐   ┌────────────────────────────┐   │
│  │ LineItemClassifier│   │  SplitTransactionService   │   │
│  │ - classifyItems() │──►│  - createSplit()           │   │
│  │ - allocateTax()   │   │  - updateSplit()           │   │
│  └──────────────────┘   └────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │              Actual Budget API                    │    │
│  │  (addTransactions / importTransactions with       │    │
│  │   subtransactions[])                              │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

## 4. Receipt-to-Transaction Matching

### 4.1 Matching Strategy

Receipts are matched to Actual Budget transactions using a multi-signal
scoring approach:

| Signal | Weight | Description |
|--------|--------|-------------|
| Amount match | High | `receipt.totalAmount` (cents) compared against `abs(transaction.amount)` (cents). Exact match or within `RECEIPT_MATCH_TOLERANCE_CENTS` tolerance. Tip is NOT included in this comparison — Veryfi's `total` field is the receipt total as printed, which may or may not include tip depending on the receipt. |
| Date match | Medium | Receipt `date` (YYYY-MM-DD, from `stamp_date`) matches transaction `date` within `RECEIPT_DATE_TOLERANCE_DAYS` (default: +/- 1 day to account for posting delay). Note: `stamp_date` can be 30+ days before the transaction date for batch-uploaded receipts. |
| Vendor/payee match | Low-Medium | Fuzzy match between receipt `vendorName` and transaction `payee`/`imported_payee`. Weight is LOW because OCR vendor names are inconsistent (e.g., "7-2-11 FOOD STORE" vs bank's "7-ELEVEN #12345"). Amount + date should carry most of the weight. |
| Already matched | Exclude | Skip transactions that already have a receipt association in `receipt_matches`. |
| Zero amount | Exclude | Skip receipts with `totalAmount === 0` (4 in corpus) — these cannot be reliably matched and would match any $0 transaction. |

**Match confidence levels:**
- **Exact**: Amount matches exactly AND date matches AND vendor fuzzy-matches
  (score >= 0.8) — auto-associate if `RECEIPT_AUTO_MATCH` is true,
  otherwise queue for user confirmation
- **Probable**: Amount matches exactly AND (date matches OR vendor matches) —
  present for user confirmation
- **Possible**: Amount matches within tolerance OR only vendor matches — present
  for manual review
- **No match**: No signals align — receipt is unmatched

**`RECEIPT_AUTO_MATCH` behavior:**
When `true` (default), exact-confidence matches are automatically confirmed
without user review — the match is created and the line-item classification
pipeline proceeds immediately. The user can still review, unmatch, or rematch
after the fact. When `false`, all matches require explicit user confirmation
before classification begins.

### 4.2 Unmatched Item Tracking

Both sides of the matching equation must be tracked so that unmatched items
are clearly visible and actionable:

**Unmatched transactions** — Actual Budget transactions that have no
receipt match. These are tracked by comparing all transactions in the
configured accounts/date range against the `receipt_matches` table. Any
transaction without a corresponding match row is "unmatched." The system
maintains a `transaction_receipt_status` view (or equivalent query) that
joins transactions with their match status.

**Unmatched receipts** — Veryfi receipts that did not match any
transaction. These are receipts in the `receipts` table with no
corresponding row in `receipt_matches`. Common reasons: the bank
transaction hasn't posted yet, the amount differs (e.g. tip added after
receipt), or the receipt is from a non-synced account.

**Visibility:**
- The Review UI surfaces both unmatched transactions and unmatched
  receipts in dedicated views, with filters for date range, account,
  vendor, and amount.
- Unmatched items persist indefinitely — they are not discarded after a
  matching run. A receipt uploaded today might match a transaction that
  posts three days later.
- Users can manually match any unmatched receipt to any unmatched
  transaction (or even an already-matched transaction, which triggers
  a rematch — see Section 4.4).

**Deferred matching:**
- When a user later locates a physical receipt and scans it into Veryfi,
  the next fetch cycle picks it up and attempts matching against all
  unmatched transactions (not just recent ones).
- Users can also trigger a manual re-match run from the UI that
  re-evaluates all unmatched items on both sides.

### 4.3 Match Persistence

Receipt-transaction associations are stored in the classification SQLite
database. Receipts are first stored in the `receipts` table (Section 10),
then matches reference them by internal ID:

```sql
-- See Section 10 for full schema. Key fields for matching:
CREATE TABLE receipt_matches (
  id TEXT PRIMARY KEY,
  transactionId TEXT NOT NULL,
  receiptId TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  matchConfidence TEXT NOT NULL,       -- exact, probable, possible, manual
  matchedAt TEXT NOT NULL,
  status TEXT DEFAULT 'pending',       -- pending, classified, approved, applied, rejected
  preSplitSnapshot TEXT,              -- original transaction JSON before split (for rollback)

  UNIQUE(transactionId, receiptId)
);
```

**Status progression:** `pending` → `classified` (line-items classified by
LLM) → `approved` (user approved the split plan) → `applied` (split written
to Actual Budget). Can be `rejected` at any point. See Section 8.3 for the
full state machine.

### 4.4 Rematch and Correction Workflow

Matches are not permanent. Users can correct wrong matches, and the system
cascades the necessary updates:

**Unmatch** — Remove an incorrect match:

1. User selects a matched pair and chooses "Unmatch."
2. If the match status is `applied` (split already written to Actual
   Budget), the system must **roll back the split** — restore the
   original single transaction from the pre-split backup stored in the
   classification DB.
3. If the match status is `classified` or `pending`, no rollback is
   needed — just delete the match record and any associated
   `line_item_classifications`.
4. Both the transaction and receipt return to the "unmatched" pool.

**Rematch** — Change which transaction a receipt is matched to:

1. User selects a matched receipt and chooses "Rematch."
2. System performs an unmatch (with rollback if needed) on the old pair.
3. User selects the correct transaction from the unmatched transaction
   list (with search/filter by date, amount, payee).
4. A new match is created with confidence `manual`.
5. The line-item classification pipeline runs on the new match.
6. User reviews and approves the new split before it's applied.

**Rematch from the transaction side:**
- User can also start from a transaction and say "this receipt is wrong,
  match a different one" — same flow, opposite starting point.

**Audit trail:**
- All match changes are logged in a `receipt_match_history` table so the
  full history of match/unmatch/rematch operations is preserved. Each
  entry records the old match, the new match (if rematch), who/what
  initiated it, and a timestamp.

**Cascade rules:**

| Prior State | Unmatch Action | Rematch Action |
|---|---|---|
| `pending` | Delete match row | Delete old, create new match |
| `classified` | Delete match + line_item_classifications | Delete old + classifications, re-classify new |
| `applied` | Roll back split in Actual Budget, delete match + classifications | Roll back old split, delete old records, create new match, re-classify |
| `rejected` | Delete match row | Delete old, create new match |

### 4.5 New API Endpoints for Matching

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/transactions/unmatched` | List transactions with no receipt match (filterable by date, account, amount) |
| GET | `/api/receipts/unmatched` | List receipts with no transaction match |
| POST | `/api/matches/:id/unmatch` | Remove a match (with rollback if applied) |
| POST | `/api/matches/:id/rematch` | Rematch to a different transaction (body: `{ transactionId }`) |
| POST | `/api/matching/run` | Trigger a re-evaluation of all unmatched items |
| GET | `/api/matches/:id/history` | Audit trail for a match |

## 5. Line-Item Classification

### 5.1 Classification Pipeline

For each matched receipt, the line-item classifier processes every item:

1. **Build context**: Gather the transaction's payee, account, date, and the
   full list of Actual Budget categories (same as existing pipeline).
2. **Classify each line-item**: For each `ReceiptLineItem`, generate a prompt
   that includes the item description, quantity, price, and (optionally) the
   provider's category guess. Use the same LLM + rules + web search pipeline.
3. **Batch optimization**: Send multiple line-items from the same receipt in a
   single LLM call when possible, to reduce API calls and improve context
   (the LLM can see all items together for a given store).
4. **Allocate tax**: Distribute the receipt's total tax across line-items
   (see Section 5.2).
5. **Allocate additional charges**: Distribute tips, fees, shipping across
   items proportionately (or assign to a specific category if appropriate).
6. **Produce split plan**: Output a list of `{ category, amount, notes }`
   entries that become Actual Budget subtransactions.

### 5.2 Sales Tax Allocation

Tax is **not** a separate budget category. It is distributed across line-items
proportionately so each split subtransaction reflects the true cost including
tax.

**Order of operations:**

1. **Distribute discount** across items proportionately (reduces each
   item's totalPrice). This happens BEFORE tax allocation.
2. **Allocate tax** on the discounted amounts.
3. **Add tip/shipping/fee** as separate subtransactions (NOT distributed).

**Tax allocation algorithm:**

```
Input:
  lineItems[]       — each with totalPrice (after discount) and taxable flag
  totalTax           — total tax amount from receipt (cents, integer)
  taxableIndicator   — whether any items have taxable !== null

If totalTax === 0:
  Skip allocation entirely. Each item's amountWithTax = totalPrice.

If taxableIndicator is present (some items marked taxable, others not):
  taxableTotal = sum of totalPrice for items where taxable === true
  If taxableTotal === 0:
    Treat as "no taxable indicator" (fall through to proportional allocation)
  For each taxable item:
    itemTax = Math.round(totalTax * (item.totalPrice / taxableTotal))
    item.amountWithTax = item.totalPrice + itemTax
  For each non-taxable item:
    item.amountWithTax = item.totalPrice

If no taxable indicator (taxable is null for all items):
  allItemsTotal = sum of totalPrice for all items
  If allItemsTotal === 0:
    Skip allocation. Each item's amountWithTax = 0.
  For each item:
    itemTax = Math.round(totalTax * (item.totalPrice / allItemsTotal))
    item.amountWithTax = item.totalPrice + itemTax

Rounding adjustment (applies to both paths above):
  remainder = totalTax - sum of all itemTax values
  If remainder !== 0:
    Find the item with the largest absolute totalPrice
    Add remainder to that item's itemTax and amountWithTax
    (remainder may be positive or negative — handles both excess
    and deficit from rounding)
```

**Validation:** After allocation, assert:
`sum(amountWithTax for all items) + sum(additionalCharges) === receipt.totalAmount`
If not equal, log the discrepancy and adjust the largest item to force balance.
This is expected for the 46% of Veryfi receipts where amounts don't reconcile.

**Example:**

Receipt from Walmart:
```
Bananas          $2.50  T
Milk             $4.00  T
Diapers         $12.00  T
Cold Medicine    $8.50  T
Magazine         $5.00
  Subtotal:     $32.00
  Tax:           $1.89
  Total:        $33.89
```

Taxable total = $27.00 (all T items).
Tax per item: Bananas $0.18, Milk $0.28, Diapers $0.84, Medicine $0.59.
Sum = $1.89. No rounding adjustment needed.

Split transaction in Actual Budget:
| Subtransaction | Category | Amount |
|---|---|---|
| Bananas | Groceries | -$2.68 |
| Milk | Groceries | -$4.28 |
| Diapers | Baby & Kids | -$12.84 |
| Cold Medicine | Health & Medical | -$9.09 |
| Magazine | Entertainment | -$5.00 |
| **Total** | | **-$33.89** |

### 5.3 Additional Charge Allocation

| Charge Type | Default Handling |
|---|---|
| **Tip** | Added as a separate subtransaction, categorized as "Dining Out" or the same category as the main items |
| **Discount** | Distributed proportionately across all items (reduces each item's amount) |
| **Shipping** | Separate subtransaction, categorized as "Shopping" or "Shipping & Delivery" |
| **Fee** | Separate subtransaction, categorized to the most relevant category or "Fees & Charges" |

### 5.4 Line-Item LLM Prompt

The existing prompt template is extended for line-item mode. Instead of asking
the LLM to categorize one transaction, it receives the full receipt context:

```
I want to categorize the individual items from a receipt/invoice.

Store/Vendor: {{vendorName}}
Transaction Date: {{date}}
Account: {{accountName}}

Receipt line items:
{{#each lineItems}}
{{incIndex @index}}. {{description}} — qty {{quantity}} @ {{unitPrice}} = {{totalPrice}}
{{/each}}

{{#if additionalCharges}}
Additional charges:
{{#each additionalCharges}}
- {{type}}: {{description}} {{amount}}
{{/each}}
{{/if}}

Existing categories by group:
{{#each categoryGroups}}
GROUP: {{name}} (ID: "{{id}}")
{{#each categories}}
* {{name}} (ID: "{{id}}")
{{/each}}
{{/each}}

IMPORTANT: Respond with a JSON array — one entry per line item, in order:
[
  { "itemIndex": 0, "type": "existing", "categoryId": "...", "confidence": "high"|"medium"|"low" },
  ...
]

For items you cannot confidently categorize, set confidence to "low" and
provide your best guess. The system will fall back to alternative methods
for low-confidence items.
```

### 5.5 Fallback Behavior

**Receipts with 0 line items (6% of Veryfi corpus):**
Skip the line-item classification pipeline entirely. The receipt still
matches the transaction (by amount/date), but classification uses the
existing whole-transaction AI pipeline. The match status stays at `pending`
(no line-item classification step).

**When a line-item classification has low confidence:**

1. If the receipt has only 1-2 items, fall back to the existing whole-
   transaction classification (AI + rules + web search on the payee/amount).
   Don't create a split — assign the single category to the whole transaction.
2. If the LLM returns a low-confidence result for an individual item, attempt
   a secondary classification using just that item's description as a
   standalone query with web search enabled.
3. If still uncertain, use the whole-transaction classification as the
   category for that line-item (the existing actual-ai behavior).
4. If ALL fallbacks fail for an item, assign the same category as the
   majority of other items on the receipt. If no majority exists, leave the
   item's `suggestedCategoryId` as null and set status to `pending` for
   manual review — the user must assign a category before the split can
   be applied.

## 6. Split Transaction Support in actual-ai

### 6.1 Current State

Actual Budget natively supports split transactions:
- Parent transaction: `is_parent = true`, no category, `subtransactions[]` array
- Child transactions: `is_child = true`, `parent_id` set, each has own
  `category`, `amount`, `notes`
- Created via `addTransactions()` or `importTransactions()` with a
  `subtransactions` field on the transaction object

actual-ai currently:
- **Excludes** parent transactions from categorization (`!is_parent` filter)
- Processes child transactions individually (if they exist)
- Does NOT create split transactions — it only assigns a single category to
  a whole transaction

### 6.2 New Split Transaction Service

A new `SplitTransactionService` will handle converting a classified receipt
into Actual Budget split transactions:

```typescript
interface SplitPlan {
  transactionId: string;          // Existing Actual Budget transaction ID
  splits: SplitEntry[];           // One per line-item (+ charges)
}

interface SplitEntry {
  amount: number;                 // In cents, negative for expenses
  categoryId: string;             // Actual Budget category ID
  notes: string;                  // Line-item description
}
```

**Implementation approach:**

The `@actual-app/api` supports `subtransactions` on create/import but NOT on
`updateTransaction()`. To convert an existing single transaction into a split:

1. **Snapshot** the original transaction (store full JSON in
   `receipt_matches.preSplitSnapshot` for rollback)
2. **Delete** the original transaction
3. **Re-create** it via `importTransactions()` with the same fields plus
   `subtransactions[]`
4. Preserve the original transaction's `id`, `date`, `payee`, `account`,
   `imported_payee`, `notes`, and `cleared`/`reconciled` status

**CRITICAL: Transaction ID preservation.**
The Actual Budget API may or may not preserve the transaction ID when
re-importing. This MUST be verified during Phase 4 implementation:
- If ID is preserved: use it as-is, all references remain valid.
- If ID changes: update `receipt_matches.transactionId` and
  `classifications.transactionId` to the new ID. Store a mapping of
  `oldId → newId` in the pre-split snapshot for audit purposes.
- If ID preservation is unreliable: consider using the lower-level batch
  update API or finding an alternative approach that doesn't require
  delete + re-create.

**Interaction with existing classification pipeline:**

actual-ai marks processed transactions with note tags:
- `guessedTag` (e.g., `#actual-ai`) — appended when a category is assigned
- `notGuessedTag` (e.g., `#actual-ai-miss`) — appended when classification fails

Receipt-classified transactions should use a distinct tag:
- `receiptTag` (e.g., `#actual-ai-receipt`) — appended when a receipt-based
  split is applied

This prevents the existing transaction filter from skipping receipt-matched
transactions (it excludes transactions with `guessedTag`), and allows users
to distinguish between AI-guessed and receipt-based classifications. When
unmatching/rolling back a split, the `receiptTag` must be removed from the
transaction notes.

**Safeguards:**
- Never split an already-split transaction (check `is_parent`)
- Never split a reconciled transaction without user confirmation
- Always verify subtransaction amounts sum to the original transaction amount
- Store the pre-split state in the classification DB for rollback capability
- On rollback: restore original transaction from snapshot, remove
  `receiptTag` from notes, verify the restored transaction appears in
  the unmatched pool

### 6.3 Actual API Service Extensions

New methods on `ActualApiService`:

```typescript
// Create a split from an existing transaction
async splitTransaction(
  transactionId: string,
  subtransactions: { amount: number; category: string; notes: string }[],
): Promise<void>;

// Get full transaction details including subtransactions
async getTransactionWithSplits(transactionId: string): Promise<TransactionEntity>;
```

## 7. Review UI Integration

### 7.1 Receipt Match Review

The existing Review UI (see REVIEW-UI-REQUIREMENTS.md) is extended with:

- **Receipt match queue**: List of receipts awaiting transaction matching.
  User can confirm auto-matches, resolve probable/possible matches, or
  manually associate receipts to transactions.
- **Unmatched transactions view**: All transactions without a receipt
  match, filterable by date range, account, and amount. Users can
  select one and manually associate a receipt (from the unmatched
  receipts pool or by triggering a new Veryfi fetch).
- **Unmatched receipts view**: All Veryfi receipts without a transaction
  match. Shows vendor, amount, date, and line-item count. Users can
  select one and manually match to a transaction.
- **Match correction**: For any existing match, users can unmatch (return
  both items to the unmatched pool) or rematch (swap to a different
  transaction). If a split was already applied, the system rolls back
  the split before unmatching.
- **Receipt detail view**: Shows receipt image (if available), all line items,
  tax breakdown, and the proposed split categorization side-by-side.
- **Split preview**: Before applying, show a visual breakdown of how the
  transaction will be split (amounts, categories, tax allocation).

### 7.2 Line-Item Review Actions

Per line-item:
- Approve suggested category
- Change category (dropdown of existing categories)
- Merge with adjacent item (combine two line-items into one subtransaction)

Batch:
- Approve all line-items on a receipt
- Reject entire receipt match (don't split this transaction)

### 7.3 New API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/receipts` | List fetched receipts with match status |
| GET | `/api/receipts/:id` | Single receipt detail with line items |
| POST | `/api/receipts/fetch` | Trigger receipt fetch from all connectors |
| POST | `/api/receipts/:id/match` | Manually match a receipt to a transaction |
| GET | `/api/receipts/:id/splits` | Preview proposed split for a matched receipt |
| POST | `/api/receipts/:id/classify` | Trigger line-item classification |
| POST | `/api/receipts/:id/apply` | Apply the split to Actual Budget |
| GET | `/api/connectors` | List configured receipt connectors |
| POST | `/api/connectors/:id/test` | Test connector connectivity |

## 8. Data Flow

### 8.1 Full Pipeline (Happy Path)

```
1. Receipt fetch
   ReceiptConnectorRegistry → VeryfiConnector.fetchReceipts()
   → Normalized ReceiptDocument[] stored in SQLite

2. Transaction matching
   ReceiptMatchingService.matchReceipts()
   → Compare receipts against uncategorized Actual Budget transactions
   → Store matches in receipt_matches table
   → Auto-confirm exact matches; queue others for review

3. Line-item classification
   LineItemClassifier.classifyItems(receipt, transaction)
   → Build batch prompt with all line items
   → LLM categorizes each item
   → Low-confidence items → fallback pipeline
   → Tax allocation applied
   → SplitPlan produced

4. User review (Review UI)
   → User reviews proposed splits
   → Approves/modifies/rejects per line-item
   → Approved splits queued for application

5. Apply to Actual Budget
   SplitTransactionService.createSplit(splitPlan)
   → Original transaction converted to parent + subtransactions
   → Each subtransaction has its own category and notes
   → Classification record updated to "applied"
```

### 8.2 Interaction with Existing Classification Pipeline

```
For each uncategorized transaction:
  1. Check if a matched receipt exists
     → YES: Use line-item classification pipeline (this doc)
     → NO:  Use existing whole-transaction classification (current behavior)

Both paths feed into the same Review UI for approval.
```

The receipt-based classification **overrides** the generalized AI guess when
available. If the receipt pipeline partially fails (some items unclassifiable),
only those items fall back to the generalized approach.

### 8.3 Receipt Match State Machine

```
                 ┌──────────┐
                 │ (no match)│  ← receipt & transaction in unmatched pools
                 └─────┬─────┘
                       │ match (auto or manual)
                       ▼
                 ┌──────────┐
                 │ pending   │  ← matched, awaiting classification
                 └─────┬─────┘
                       │ classify (LLM line-item pipeline)
                       ▼
                 ┌──────────┐
                 │classified │  ← line items classified, split plan ready
                 └─────┬─────┘
                       │ user approves split plan
                       ▼
                 ┌──────────┐
                 │ approved  │  ← user approved, ready to apply
                 └─────┬─────┘
                       │ apply to Actual Budget
                       ▼
                 ┌──────────┐
                 │ applied   │  ← split written to Actual Budget
                 └──────────┘

  Any state → rejected (user rejects at any point)
  Any state → (no match) (user unmatches; rollback if applied)
```

## 9. Configuration

### 9.1 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RECEIPT_CONNECTORS` | `""` | Comma-separated list of enabled connectors (e.g., `"veryfi"`) |
| `VERYFI_USERNAME` | `""` | Veryfi account username (email) |
| `VERYFI_PASSWORD` | `""` | Veryfi account password |
| `VERYFI_TOTP_SECRET` | `""` | Base32-encoded TOTP secret for Veryfi MFA |
| `RECEIPT_MATCH_TOLERANCE_CENTS` | `5` | Amount tolerance for matching (in cents) |
| `RECEIPT_DATE_TOLERANCE_DAYS` | `1` | Date tolerance for matching (in days) |
| `RECEIPT_AUTO_MATCH` | `true` | Auto-confirm exact matches without user review |
| `RECEIPT_FETCH_DAYS_BACK` | `30` | How many days back to fetch receipts on each run |
| `RECEIPT_TAG` | `"#actual-ai-receipt"` | Note tag applied to receipt-split transactions |

**Note on Veryfi authentication:** This integration uses Veryfi's internal
web API (`iapi.veryfi.com/api/v7`), NOT the official developer API. Auth
requires a 5-step browser login flow with TOTP MFA (see `src/veryfi/auth.ts`).
The `client-id` and `veryfi-session` headers are extracted automatically at
runtime — no API keys are configured statically.

### 9.2 Feature Flags

| Flag | Description |
|------|-------------|
| `receiptMatching` | Enable the receipt matching pipeline |
| `lineItemClassification` | Enable per-line-item classification (requires `receiptMatching`) |
| `autoSplitTransactions` | Auto-apply exact-match receipt splits without review |

**Flag dependencies:** `lineItemClassification` requires `receiptMatching`.
`autoSplitTransactions` requires both `receiptMatching` and
`lineItemClassification`. On startup, validate that dependencies are
satisfied — if a flag is enabled but its dependency is not, log a warning
and disable the dependent flag.

## 10. Database Schema Additions

```sql
-- Receipt documents fetched from OCR providers
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,                -- UUID
  externalId TEXT NOT NULL,           -- Provider-specific ID
  providerId TEXT NOT NULL,           -- e.g., "veryfi"
  vendorName TEXT,
  totalAmount INTEGER NOT NULL,       -- cents
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  currency TEXT DEFAULT 'USD',
  lineItemCount INTEGER DEFAULT 0,
  taxAmount INTEGER DEFAULT 0,        -- cents
  receiptData TEXT NOT NULL,          -- Full ReceiptDocument JSON
  fetchedAt TEXT NOT NULL,            -- ISO 8601

  UNIQUE(providerId, externalId)
);

-- Receipt-to-transaction matches
CREATE TABLE receipt_matches (
  id TEXT PRIMARY KEY,
  transactionId TEXT NOT NULL,
  receiptId TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  matchConfidence TEXT NOT NULL,       -- exact, probable, possible, manual
  matchedAt TEXT NOT NULL,
  status TEXT DEFAULT 'pending',       -- pending, classified, approved, applied, rejected
  preSplitSnapshot TEXT,              -- original transaction JSON before split (for rollback)

  UNIQUE(transactionId, receiptId)
);

-- Audit trail for match/unmatch/rematch operations
CREATE TABLE receipt_match_history (
  id TEXT PRIMARY KEY,                -- UUID
  receiptId TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  oldTransactionId TEXT,              -- NULL on first match
  newTransactionId TEXT,              -- NULL on unmatch
  action TEXT NOT NULL,               -- match, unmatch, rematch
  oldMatchConfidence TEXT,
  newMatchConfidence TEXT,
  reason TEXT,                        -- user-supplied or system-generated note
  performedAt TEXT NOT NULL,          -- ISO 8601
  performedBy TEXT DEFAULT 'system'   -- system, user, auto-reauth
);

-- Per-line-item classification results
CREATE TABLE line_item_classifications (
  id TEXT PRIMARY KEY,
  receiptMatchId TEXT NOT NULL REFERENCES receipt_matches(id) ON DELETE CASCADE,
  lineItemIndex INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL DEFAULT 1,
  unitPrice INTEGER NOT NULL,         -- cents
  totalPrice INTEGER NOT NULL,        -- cents
  taxable INTEGER,                    -- 1, 0, or NULL (unknown)
  allocatedTax INTEGER DEFAULT 0,     -- cents
  amountWithTax INTEGER NOT NULL,     -- cents (totalPrice + allocatedTax)
  suggestedCategoryId TEXT,
  suggestedCategoryName TEXT,
  classificationType TEXT,            -- existing, new, rule, fallback
  confidence TEXT,                    -- high, medium, low
  status TEXT DEFAULT 'pending',      -- pending, approved, rejected
  notes TEXT,

  UNIQUE(receiptMatchId, lineItemIndex)
);

-- Convenience view: transaction receipt status (for unmatched queries)
CREATE VIEW transaction_receipt_status AS
SELECT
  rm.transactionId,
  rm.receiptId,
  rm.status AS matchStatus,
  rm.matchConfidence,
  r.vendorName,
  r.totalAmount,
  r.date AS receiptDate,
  r.lineItemCount,
  (SELECT COUNT(*) FROM line_item_classifications lic
   WHERE lic.receiptMatchId = rm.id AND lic.status = 'approved') AS approvedItems,
  (SELECT COUNT(*) FROM line_item_classifications lic
   WHERE lic.receiptMatchId = rm.id) AS totalItems
FROM receipt_matches rm
JOIN receipts r ON r.id = rm.receiptId;
```

**Schema notes:**
- All foreign keys use `ON DELETE CASCADE` so deleting a receipt cleans up
  matches, classifications, and history automatically.
- `receipt_matches.status` includes `approved` between `classified` and
  `applied` to represent user approval before the split is written.
- The `transaction_receipt_status` view simplifies queries for the Review UI
  and unmatched transaction/receipt views.

## 11. Implementation Phases

### Phase 1: Foundation
- Receipt connector interface and registry
- Veryfi adapter (first provider)
- Receipt fetch and storage
- Configuration and feature flags

### Phase 2: Matching
- Transaction-to-receipt matching algorithm
- Match persistence and confidence scoring
- Unmatched item tracking (both sides: transactions without receipts, receipts without transactions)
- Rematch and correction workflow (unmatch, rematch, rollback, audit history)
- Review UI: receipt match queue, unmatched views, match correction

### Phase 3: Line-Item Classification
- Line-item prompt template
- Batch line-item LLM classification
- Sales tax allocation algorithm
- Additional charge distribution
- Fallback to whole-transaction classification

### Phase 4: Split Transactions
- `SplitTransactionService` — create/update splits via Actual Budget API
- Pre-split state backup for rollback
- Split preview in Review UI
- Apply approved splits to Actual Budget

### Phase 5: Review UI Extensions
- Receipt detail view with line items
- Split preview visualization
- Per-line-item approve/reject/re-categorize
- Receipt image display

## 12. Constraints and Edge Cases

### Edge Cases

| Scenario | Handling |
|---|---|
| Receipt total doesn't match transaction amount | Flag as "possible" match; user confirms. Could be partial payment, tips added later, or return. |
| Receipt has no line items (OCR failure) | Fall back to whole-transaction classification. Store receipt for reference. |
| Multiple receipts match one transaction | Present all candidates to user for manual selection. |
| One receipt matches multiple transactions | Could be a return + purchase. Present for manual review. |
| Transaction already has subtransactions | Skip — don't re-split an existing split. |
| Reconciled transaction | Warn user before splitting; require explicit confirmation. |
| Line-item amount is $0 | Skip or assign to same category as adjacent items. |
| Receipt in foreign currency | Convert using transaction's actual amount; flag currency mismatch. |
| Duplicate receipts (same receipt scanned twice) | Deduplicate by provider + externalId (UNIQUE constraint). Additionally, detect near-duplicates: receipts from the same vendor, same date, and same total within 5 cents — flag as "possible duplicate" and log a warning rather than silently ingesting both. |
| Tax amount doesn't match sum of taxable items * rate | Use the receipt's stated tax total; log the discrepancy. |
| Unmatch after split was applied | Roll back the split (restore pre-split snapshot), then unmatch. Warn user that applied categorizations will be reverted. |
| Rematch to a transaction that already has a different receipt | Prompt user: unmatch the existing pair first, or cancel. Never silently overwrite. |
| Receipt fetched but bank transaction hasn't posted yet | Receipt stays unmatched. Next matching run (or manual re-run) picks it up when the transaction appears. |
| User finds physical receipt weeks later | Scan into Veryfi, next fetch picks it up, matching run evaluates against all unmatched transactions regardless of age. |

### Constraints

- All amounts are integers in cents (Actual Budget convention).
- Subtransaction amounts MUST sum exactly to the parent transaction amount.
  Any rounding difference is applied to the largest subtransaction.
- The `@actual-app/api` supports `subtransactions` on create/import but NOT
  on `updateTransaction()`. Converting an existing transaction to a split
  requires delete + re-create (or internal batch API).
- Receipt images are NOT stored locally — only the provider's image URL is
  referenced. Veryfi image URLs may expire or require authentication. The
  Review UI should handle HTTP 401/403 on image fetch gracefully (show a
  placeholder, offer a "re-fetch" button that re-authenticates and refreshes
  the URL).
- Line-item merge in the Review UI (Section 7.2) is a UI-only operation.
  When two line items are merged, the resulting item's `description` is the
  concatenation, `totalPrice` is the sum, and the merge is recorded in the
  `notes` field of the `line_item_classifications` row (e.g.,
  `"merged from items 2 and 3"`). No separate tracking table is needed.

## 13. Non-Goals (Out of Scope)

- Uploading/scanning receipts directly through actual-ai (use the OCR
  provider's app/API for that).
- Training or fine-tuning the LLM based on user corrections.
- Multi-currency conversion (beyond noting the discrepancy).
- Receipt archival or long-term document management.
- Automatic receipt capture from email/SMS.
