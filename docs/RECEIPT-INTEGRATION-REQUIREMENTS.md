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
   */
  fetchReceipts(dateFrom: string, dateTo: string): Promise<ReceiptDocument[]>;

  /**
   * Fetch a single receipt by its provider-specific ID.
   */
  getReceipt(externalId: string): Promise<ReceiptDocument | null>;

  /**
   * Test connectivity and authentication with the provider.
   */
  testConnection(): Promise<{ ok: boolean; message: string }>;
}
```

### 3.2 Normalized Receipt Data Model

All provider adapters normalize their responses into this common structure:

```typescript
interface ReceiptDocument {
  /** Provider-specific document ID */
  externalId: string;

  /** Which connector produced this (e.g., "veryfi") */
  providerId: string;

  /** Vendor/merchant name as recognized by OCR */
  vendorName: string;

  /** Total amount in cents (integer, negative for expenses) */
  totalAmount: number;

  /** Transaction date (YYYY-MM-DD) */
  date: string;

  /** Currency code (e.g., "USD") */
  currency: string;

  /** Individual line items */
  lineItems: ReceiptLineItem[];

  /** Tax information */
  tax: ReceiptTax;

  /** Optional: tips, discounts, shipping, etc. */
  additionalCharges: ReceiptAdditionalCharge[];

  /** Raw OCR text (for debugging / fallback analysis) */
  ocrText?: string;

  /** URL to receipt image in the provider's system */
  imageUrl?: string;

  /** Provider-specific metadata (preserved for reference) */
  providerMeta?: Record<string, unknown>;
}

interface ReceiptLineItem {
  /** Line-item description as recognized by OCR */
  description: string;

  /** Quantity (default 1) */
  quantity: number;

  /** Unit price in cents */
  unitPrice: number;

  /** Total price for this line in cents (quantity * unitPrice) */
  totalPrice: number;

  /** SKU or product code, if recognized */
  sku?: string;

  /** Whether this item is taxable. null = unknown. */
  taxable?: boolean | null;

  /** Provider-specific category/type guess (informational) */
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
  amount: number; // cents
}
```

### 3.3 Veryfi Adapter (First Implementation)

The first concrete adapter implements `ReceiptConnector` for Veryfi.co:

```typescript
class VeryfiConnector implements ReceiptConnector {
  readonly providerId = 'veryfi';
  readonly providerName = 'Veryfi';

  constructor(
    private clientId: string,
    private clientSecret: string,
    private username: string,
    private apiKey: string,
    private baseUrl?: string,  // default: https://api.veryfi.com/api/v8
  ) {}

  // Maps Veryfi's document JSON → ReceiptDocument
  // Maps Veryfi's line_items[] → ReceiptLineItem[]
  // Maps Veryfi's tax field → ReceiptTax
}
```

**Veryfi API fields mapped to ReceiptDocument:**

| Veryfi Field | ReceiptDocument Field |
|---|---|
| `id` | `externalId` |
| `vendor.name` | `vendorName` |
| `total` | `totalAmount` |
| `date` | `date` |
| `currency_code` | `currency` |
| `line_items[].description` | `lineItems[].description` |
| `line_items[].quantity` | `lineItems[].quantity` |
| `line_items[].price` | `lineItems[].unitPrice` |
| `line_items[].total` | `lineItems[].totalPrice` |
| `line_items[].sku` | `lineItems[].sku` |
| `line_items[].tax` | used to infer `lineItems[].taxable` |
| `line_items[].category` | `lineItems[].providerCategory` |
| `tax` | `tax.totalTax` |
| `tip` | `additionalCharges` (type: tip) |
| `discount` | `additionalCharges` (type: discount) |
| `shipping` | `additionalCharges` (type: shipping) |
| `ocr_text` | `ocrText` |
| `img_url` | `imageUrl` |

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
| Amount match | High | Receipt total (including tax/tip) matches transaction amount exactly or within a small tolerance (e.g., +/- $0.05 for rounding) |
| Date match | Medium | Receipt date matches transaction date (+/- 1 day to account for posting delay) |
| Vendor/payee match | Medium | Fuzzy match between receipt vendor name and transaction payee/imported_payee |
| Already matched | Exclude | Skip transactions that already have a receipt association |

**Match confidence levels:**
- **Exact**: Amount matches exactly AND date matches AND vendor fuzzy-matches
  (score >= 0.8) — auto-associate
- **Probable**: Amount matches exactly AND (date matches OR vendor matches) —
  present for user confirmation
- **Possible**: Amount matches within tolerance OR only vendor matches — present
  for manual review
- **No match**: No signals align — receipt is unmatched

### 4.2 Match Persistence

Receipt-transaction associations are stored in the classification SQLite
database:

```sql
CREATE TABLE receipt_matches (
  id TEXT PRIMARY KEY,                -- UUID
  transactionId TEXT NOT NULL,        -- Actual Budget transaction ID
  receiptExternalId TEXT NOT NULL,    -- Provider-specific receipt ID
  providerId TEXT NOT NULL,           -- e.g., "veryfi"
  matchConfidence TEXT NOT NULL,      -- "exact", "probable", "possible", "manual"
  matchedAt TEXT NOT NULL,            -- ISO 8601 timestamp
  receiptData TEXT NOT NULL,          -- Full ReceiptDocument JSON (snapshot)
  status TEXT DEFAULT 'pending',      -- "pending", "classified", "applied", "rejected"

  UNIQUE(transactionId, receiptExternalId)
);
```

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

**Algorithm:**

```
Input:
  lineItems[]       — each with totalPrice and taxable flag
  totalTax           — total tax amount from receipt
  taxableIndicator   — whether the receipt distinguishes taxable items

If taxableIndicator is present (some items marked taxable, others not):
  taxableTotal = sum of totalPrice for items where taxable === true
  For each taxable item:
    itemTax = round(totalTax * (item.totalPrice / taxableTotal))
    item.amountWithTax = item.totalPrice + itemTax
  For each non-taxable item:
    item.amountWithTax = item.totalPrice
  Adjust rounding: apply any remaining cents (totalTax - sum of itemTax)
  to the largest taxable item.

If no taxable indicator (taxable is null for all items):
  allItemsTotal = sum of totalPrice for all items
  For each item:
    itemTax = round(totalTax * (item.totalPrice / allItemsTotal))
    item.amountWithTax = item.totalPrice + itemTax
  Adjust rounding to largest item.
```

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

When a line-item classification has low confidence:

1. If the receipt has only 1-2 items, fall back to the existing whole-
   transaction classification (AI + rules + web search on the payee/amount).
2. If the LLM returns a low-confidence result for an individual item, attempt
   a secondary classification using just that item's description as a
   standalone query with web search enabled.
3. If still uncertain, use the whole-transaction classification as the
   category for that line-item (the existing actual-ai behavior).

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

1. **Delete** the original transaction
2. **Re-create** it via `importTransactions()` with the same fields plus
   `subtransactions[]`
3. Preserve the original transaction's `id`, `date`, `payee`, `account`,
   `imported_payee`, `notes`, and `cleared`/`reconciled` status

Alternatively, use the lower-level batch update API if available. This
approach needs careful testing to ensure the transaction ID is preserved
and bank sync reconciliation is not disrupted.

**Safeguards:**
- Never split an already-split transaction (check `is_parent`)
- Never split a reconciled transaction without user confirmation
- Always verify subtransaction amounts sum to the original transaction amount
- Store the pre-split state in the classification DB for rollback capability

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

## 9. Configuration

### 9.1 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RECEIPT_CONNECTORS` | `""` | Comma-separated list of enabled connectors (e.g., `"veryfi"`) |
| `VERYFI_CLIENT_ID` | `""` | Veryfi API client ID |
| `VERYFI_CLIENT_SECRET` | `""` | Veryfi API client secret |
| `VERYFI_USERNAME` | `""` | Veryfi API username |
| `VERYFI_API_KEY` | `""` | Veryfi API key |
| `VERYFI_BASE_URL` | `"https://api.veryfi.com/api/v8"` | Veryfi API base URL |
| `RECEIPT_MATCH_TOLERANCE_CENTS` | `5` | Amount tolerance for matching (in cents) |
| `RECEIPT_DATE_TOLERANCE_DAYS` | `1` | Date tolerance for matching (in days) |
| `RECEIPT_AUTO_MATCH` | `true` | Auto-confirm exact matches without user review |
| `RECEIPT_FETCH_DAYS_BACK` | `30` | How many days back to fetch receipts on each run |

### 9.2 Feature Flags

| Flag | Description |
|------|-------------|
| `receiptMatching` | Enable the receipt matching pipeline |
| `lineItemClassification` | Enable per-line-item classification (requires `receiptMatching`) |
| `autoSplitTransactions` | Auto-apply exact-match receipt splits without review |

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
  receiptId TEXT NOT NULL REFERENCES receipts(id),
  matchConfidence TEXT NOT NULL,       -- exact, probable, possible, manual
  matchedAt TEXT NOT NULL,
  status TEXT DEFAULT 'pending',       -- pending, classified, applied, rejected

  UNIQUE(transactionId, receiptId)
);

-- Per-line-item classification results
CREATE TABLE line_item_classifications (
  id TEXT PRIMARY KEY,
  receiptMatchId TEXT NOT NULL REFERENCES receipt_matches(id),
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
```

## 11. Implementation Phases

### Phase 1: Foundation
- Receipt connector interface and registry
- Veryfi adapter (first provider)
- Receipt fetch and storage
- Configuration and feature flags

### Phase 2: Matching
- Transaction-to-receipt matching algorithm
- Match persistence and confidence scoring
- Review UI: receipt match queue

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
| Duplicate receipts (same receipt scanned twice) | Deduplicate by provider + externalId. |
| Tax amount doesn't match sum of taxable items * rate | Use the receipt's stated tax total; log the discrepancy. |

### Constraints

- All amounts are integers in cents (Actual Budget convention).
- Subtransaction amounts MUST sum exactly to the parent transaction amount.
  Any rounding difference is applied to the largest subtransaction.
- The `@actual-app/api` supports `subtransactions` on create/import but NOT
  on `updateTransaction()`. Converting an existing transaction to a split
  requires delete + re-create (or internal batch API).
- Receipt images are NOT stored locally — only the provider's image URL is
  referenced.

## 13. Non-Goals (Out of Scope)

- Uploading/scanning receipts directly through actual-ai (use the OCR
  provider's app/API for that).
- Training or fine-tuning the LLM based on user corrections.
- Multi-currency conversion (beyond noting the discrepancy).
- Receipt archival or long-term document management.
- Automatic receipt capture from email/SMS.
