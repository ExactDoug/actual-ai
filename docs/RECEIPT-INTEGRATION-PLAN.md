# Receipt Integration — Implementation Plan

**Spec**: `docs/RECEIPT-INTEGRATION-REQUIREMENTS.md`
**Branch**: `feature/receipt-integration`
**Depends on**: Veryfi TypeScript client (`src/veryfi/`) — complete

**Last updated**: 2026-03-13 (Phase 7.6 complete — transaction details columns + keep-category action)

---

## Phase 1: Foundation ✅ COMPLETE

Build the receipt connector framework, wire the Veryfi adapter, and persist
fetched receipts in SQLite.

### Deliverables

- [x] Config: 10 env vars, 3 feature flags, dependency validation
- [x] Receipt store: 4 tables, 1 view, WAL mode, foreign keys
- [x] Connector interface + registry (pluggable OCR providers)
- [x] Veryfi adapter: `stamp_date`, dollars→cents, `.total` not `.price`
- [x] Receipt types: all interfaces in `src/receipt/types.ts`
- [x] Fetch service: orchestrates fetch-and-upsert with near-duplicate detection
- [x] Wired into `container.ts` and `app.ts` with feature flag gates
- [x] `npm run build` passes

**Files created**: `src/receipt/types.ts`, `connector-registry.ts`,
`veryfi-adapter.ts`, `receipt-store.ts`, `receipt-fetch-service.ts`, `index.ts`

**Files modified**: `src/config.ts`, `src/container.ts`, `app.ts`

---

## Phase 2: Transaction-to-Receipt Matching ✅ COMPLETE

### Deliverables

- [x] Multi-signal matching: amount (high), date (medium), vendor (low-med)
- [x] Confidence levels: exact, probable, possible, manual
- [x] Conflict resolution: best-scoring receipt wins per transaction
- [x] Match persistence with audit history
- [x] Unmatch and rematch operations
- [x] Wired into classification pipeline (runs before LLM classification)

**Bug fixes applied post-implementation:**
- [x] Date parsing: handles both `YYYY-MM-DD` strings and `YYYYMMDD` integers
  (Actual Budget returns integers like `20251106`)
- [x] Vendor normalization: strips apostrophes and punctuation before comparison
  (`Arby's` now matches `ARBYS 1569 - FARMINGTON NM`)
- [x] Payee resolution: resolves payee UUID → name via `getPayees()` lookup
  (TransactionEntity.payee is a UUID, not a name)

**Retroactive matching:**
- [x] Matching pool includes ALL non-split transactions (not just uncategorized)
- [x] Matches to already-categorized transactions flagged with `overridesExisting=1`
- [x] Requires explicit user approval before applying (protects existing data)

**Files created**: `src/receipt/matching-service.ts`

**Files modified**: `app.ts`, `src/receipt/receipt-store.ts`

**Tests**: 28 tests in `tests/matching-service.test.ts`

---

## Phase 3: Line-Item Classification ✅ COMPLETE

### Deliverables

- [x] Line-item prompt template (`src/templates/line-item-prompt.hbs`)
- [x] Structured output via `generateObject()` + Zod schema (JSON schema enforcement)
- [x] Tax allocation: proportional distribution with taxable flags, rounding
- [x] Receipt balance validation with discrepancy adjustment
- [x] LLM-based classification of individual line items
- [x] Low-confidence items tagged as `classificationType: "fallback"`
- [x] Classifications stored in `line_item_classifications` table
- [x] Post-LLM taxability inference from category names (NM rules: groceries
  and Rx tax-exempt, all other items taxed)
- [x] Tax reconciliation after fallback pipeline changes categories

**Live-verified (2026-03-12):**
- [x] Albertsons (7 items): 5 high, 2 low confidence — groceries classified correctly
- [x] Dollar Tree (15 items): 15/15 high confidence — craft supplies → Hobbies
- [x] Safeway (4 items): 4/4 high confidence — groceries classified correctly
- [x] Fixed: `askUsingFallbackModel` stripped quotes from JSON responses
- [x] Fixed: GPT-4.1 adds `//` comments and trailing commas to JSON
- [x] Migrated from raw text parsing to `generateObject()` with Zod schema

**Files created**: `src/receipt/tax-allocator.ts`,
`src/receipt/line-item-classifier.ts`, `src/templates/line-item-prompt.hbs`

**Files modified**: `src/llm-service.ts` (added `generateStructuredOutput()`),
`src/utils/json-utils.ts` (comment/comma stripping for other callers)

**Tests**: 14 tests in `tests/tax-allocator.test.ts`

---

## Phase 4: Split Transactions ✅ COMPLETE

### Deliverables

- [x] Split plan builder: classifications → Actual Budget subtransactions
- [x] Split transaction service: delete + re-create with snapshot rollback
- [x] Actual API extensions: `getTransactionById`, `deleteTransaction`,
  `importTransactionsWithSplits`
- [x] Safeguards: no splitting already-split or reconciled transactions
- [x] `#actual-ai-receipt` tag management (append on split, remove on rollback)
- [ ] **Not verified**: Transaction ID preservation on delete + re-create

**Files created**: `src/receipt/split-plan-builder.ts`,
`src/receipt/split-transaction-service.ts`

**Files modified**: `src/actual-api-service.ts`, `src/types.ts`

**Tests**: 9 tests in `tests/split-plan-builder.test.ts`

---

## Phase 5: Receipt API Endpoints ✅ COMPLETE

### Deliverables

- [x] 16 REST API endpoints (all behind auth middleware)
- [x] Callback-based wiring from `app.ts` to web server
- [x] Receipt listing with pagination and status filter
- [x] Manual match, classify, apply, unmatch, rematch operations
- [x] Connector listing and connectivity testing
- [x] Match history audit trail
- [ ] `GET /api/transactions/unmatched` — returns 501 (needs architecture work)

**Files modified**: `src/web/server.ts`

---

## Phase 5.5: Fallback Classification Pipeline ✅ COMPLETE

Implement the multi-tier fallback chain for low-confidence line items.
Currently, items classified with `confidence: "low"` are tagged as
`classificationType: "fallback"` and left for manual review. This phase
adds automated secondary classification using web search, individual LLM
queries, rules matching, and majority category assignment.

See `docs/RECEIPT-INTEGRATION-REQUIREMENTS.md` Section 5.5 for full spec.

### 5.5.1 — Fallback Search Query Builder

**File**: `src/receipt/line-item-classifier.ts` (or new helper)

Build optimized web search queries for low-confidence items by combining
the item description with the vendor/merchant name:

```
"AGC DINO MEMOVALEN" Albertsons product
"BLMNG UPGRADE 6" Albertsons product
"CRFTSQ METAL DURO BRSHES" Dollar Tree product
```

The vendor context is the key advantage over the existing whole-transaction
search. The original pipeline searches `"ALBERTSONS"` — the fallback
searches `"AGC DINO MEMOVALEN" Albertsons product`, which is far more
likely to identify the actual product.

Clean OCR artifacts from item descriptions before building the query:
- Replace underscores with spaces
- Remove long numeric codes (SKU numbers, UPC fragments)
- Trim excess whitespace

### 5.5.2 — Fallback Prompt Template

**New file**: `src/templates/line-item-fallback-prompt.hbs`

Single-item classification prompt that includes:
- The specific item to classify (description, qty, price)
- Vendor name and receipt date
- Web search results (top 3 snippets from Tier 1 search)
- Other items on the same receipt with their classifications (context)
- Full category list (same as primary classification)

Uses the same structured output schema as the batch classification,
but expects a single-item array.

### 5.5.3 — Tier 1: Web Search + Individual LLM

**Files modified**: `src/receipt/line-item-classifier.ts`

After the primary batch classification completes:
1. Identify all items with `confidence: "low"`
2. For each low-confidence item:
   a. Build search query: `"{description}" {vendorName} product`
   b. Call `toolService.search(query)` (uses existing cache + rate limiting)
   c. Render fallback prompt with search results + receipt context
   d. Call `generateStructuredOutput()` for single-item classification
   e. If new confidence is `"high"` or `"medium"`:
      - Update the classification in the database
      - Set `notes: "fallback:tier1:web-search"`
      - Log: `[fallback] Item N: upgraded low→{confidence} via web search`
   f. If still `"low"`, proceed to Tier 2

### 5.5.4 — Tier 2: Rules-Based Classification

**Files modified**: `src/receipt/line-item-classifier.ts`

For items still at low confidence after Tier 1:
1. Check item description against all Actual Budget transaction rules
2. The rules engine is already available via `PromptGenerator` context
3. If a rule matches:
   - Update classification with `classificationType: "rule"`
   - Set `notes: "fallback:tier2:rule-match:{ruleName}"`
4. If no rule matches, proceed to Tier 3

### 5.5.5 — Tier 3: Majority Category Assignment

**Files modified**: `src/receipt/line-item-classifier.ts`

For items still at low confidence after Tiers 1-2:
1. Collect all high/medium confidence classifications on the same receipt
2. Find the most common `suggestedCategoryId` (majority vote)
3. If a majority exists:
   - Assign that category with `classificationType: "fallback"`
   - Set `notes: "fallback:tier3:majority-category"`
4. If no majority exists (or no other items classified):
   - Leave the original LLM guess as-is
   - Set `notes: "fallback:tier4:manual-review"`
   - Item stays `status: "pending"` for manual review in the UI

### 5.5.6 — Special Case: 1-2 Item Receipts

**Files modified**: `src/receipt/line-item-classifier.ts`

If a receipt has only 1-2 items AND all items are low confidence:
- Skip the split transaction path entirely
- Fall back to the existing whole-transaction classification pipeline
  (`llmService.ask()` with the standard `prompt.hbs` template)
- This uses the full tool-calling flow (web search, rules, etc.)
- Store the result as a single classification, not a split
- Log: `[fallback] Receipt {id}: all items low confidence, using whole-transaction classification`

If only 1 of 2 items is low confidence, run the normal fallback chain
(Tiers 1-4) on that item.

### 5.5.7 — Config & Feature Flag

**File**: `src/config.ts`

New optional env var:
```
RECEIPT_FALLBACK_WEB_SEARCH=true    # default: true
```

When `false`, skip Tier 1 (web search + individual LLM) and go straight to
Tier 2 (rules). Useful if no search API key is configured or to minimize
LLM API costs.

No new feature flag — the fallback chain is gated by the existing
`lineItemClassification` feature flag.

### 5.5.8 — Wiring Changes

**Files modified**: `src/container.ts`, `app.ts`

The `LineItemClassifier` needs access to:
- `ToolService` (for web search in Tier 1) — already instantiated in container
- Transaction rules (for Tier 2) — available via `PromptGenerator` context
- `LlmService.ask()` (for whole-transaction fallback on 1-2 item receipts)

These are already available in `container.ts`; the classifier constructor
needs to accept `ToolService` as an additional dependency.

### 5.5.9 — Deliverables & Verification

- [x] Fallback prompt template created (`line-item-fallback-prompt.hbs`)
- [x] Search query builder handles OCR artifact cleanup
- [x] Tier 1: web search + individual LLM upgrades low→high/medium
- [x] Tier 2: rules engine matches item descriptions
- [x] Tier 3: majority category assignment from same-receipt items
- [x] Tier 4: items left for manual review with clear `notes` breadcrumb
- [x] 1-2 item receipt special case falls back to whole-transaction pipeline
- [x] `RECEIPT_FALLBACK_WEB_SEARCH=false` skips Tier 1
- [x] Each fallback tier logged with item index and outcome
- [x] `notes` column populated with fallback path for debugging
- [x] Unit tests for search query builder and tier progression

**Files created**: `src/templates/line-item-fallback-prompt.hbs`

**Files modified**: `src/receipt/line-item-classifier.ts` (fallback pipeline),
`src/receipt/receipt-store.ts` (updateLineItemClassification),
`src/config.ts` (receiptFallbackWebSearch),
`src/container.ts` (toolService wiring),
`app.ts` (rules fetching for classifier)

**Tests**: 10 tests in `tests/line-item-classifier.test.ts`

---

## Phase 6: Batch Operations ✅ COMPLETE

Add batch API endpoints so users can operate on multiple receipts/matches
at once instead of one-by-one API calls.

### 6.1 — Batch API Endpoints

**File**: `src/web/server.ts`

New endpoints:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/batch/classify` | Classify multiple matched receipts |
| POST | `/api/batch/approve` | Approve line items across multiple matches |
| POST | `/api/batch/apply` | Apply splits for multiple approved matches |
| POST | `/api/batch/unmatch` | Unmatch multiple matches |
| POST | `/api/batch/reject` | Reject multiple matches |
| POST | `/api/batch/reclassify` | Re-run classification on already-classified matches |

**Request format** — all batch endpoints accept either explicit IDs or a filter:

```typescript
interface BatchRequest {
  // Option A: explicit selection
  matchIds?: string[];

  // Option B: filter-based selection
  filter?: {
    status?: MatchStatus | MatchStatus[];       // e.g., "pending", ["pending", "classified"]
    confidence?: MatchConfidence | MatchConfidence[];  // e.g., "exact", ["exact", "probable"]
    overridesExisting?: boolean;                 // only matches that override existing categories
    vendor?: string;                             // substring match on vendor name
    dateFrom?: string;                           // receipt date range (YYYY-MM-DD)
    dateTo?: string;
    amountMin?: number;                          // receipt amount range (cents)
    amountMax?: number;
  };

  // Safety: maximum items to process (default 50, max 200)
  limit?: number;
}
```

**Response format**:

```typescript
interface BatchResponse {
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ matchId: string; error: string }>;
}
```

### 6.2 — Re-classification Support

**File**: `src/receipt/line-item-classifier.ts`

Currently `classifyReceipt()` returns early if match status !== `'pending'`.
Change to:
- Allow re-classification when status is `'classified'` or `'rejected'`
- Delete existing classifications before re-running
- Log that this is a re-classification (include previous classification count)
- Do NOT allow re-classification of `'applied'` matches (must rollback first)

### 6.3 — Batch Orchestration Service

**New file**: `src/receipt/batch-service.ts`

Thin orchestration layer that coordinates batch operations:
- Resolves filter → match IDs (queries receipt store)
- Validates preconditions (correct status for each operation)
- Calls existing individual services (classifier, split service, matching service)
- Collects results and errors
- Returns batch response

This keeps the individual services unchanged and testable; the batch service
is just a loop with error collection.

### 6.4 — Deliverables & Verification

- [x] All 6 batch endpoints functional
- [x] Filter-based selection works with all filter fields
- [x] Explicit matchIds selection works
- [x] Re-classification deletes old classifications and re-runs LLM
- [x] Partial failures don't abort the batch (each item independent)
- [x] Limit parameter prevents runaway batch operations
- [x] Unit tests for batch service filter resolution and error collection

**Files created**: `src/receipt/batch-service.ts`

**Files modified**: `src/receipt/receipt-store.ts` (getMatchesByFilter),
`src/receipt/line-item-classifier.ts` (re-classification support),
`src/receipt/index.ts` (barrel export),
`src/web/server.ts` (6 batch endpoints + callbacks),
`src/container.ts` (BatchService wiring),
`app.ts` (batch callbacks + fetchClassificationContext helper)

**Tests**: 16 tests in `tests/batch-service.test.ts`

---

## Phase 7: Review UI — Receipt Views ✅ COMPLETE

Build the HTML views for the receipt workflow in the Review UI. All views
must support filtering, sorting, selection, and bulk actions.

### 7.1 — Shared UI Patterns

All list views follow a consistent pattern:

**Filtering toolbar** (top of every list):
- Text search (vendor name, payee, description)
- Date range picker (receipt date and/or transaction date)
- Amount range (min/max)
- Status dropdown (pending, classified, approved, applied, rejected)
- Confidence dropdown (exact, probable, possible, manual)
- Override filter (all / overrides existing / new only)
- Account filter (Actual Budget account)
- Clear filters button
- Filters apply immediately (no submit button) via query parameters

**Selection + bulk actions** (below filter toolbar):
- Checkbox on each row + "select all" checkbox in header
- "Select all N matching" link to select beyond current page
- Bulk action bar appears when items are selected:
  - Classify selected
  - Approve selected
  - Apply selected
  - Reject selected
  - Unmatch selected
  - Re-classify selected
- Confirmation dialog for destructive actions (unmatch, reject) and
  override actions (applying to already-categorized transactions)

**Pagination**: page size selector (25/50/100), prev/next, total count.

**Sorting**: click column headers to sort. Default: most recent first.

### 7.2 — Receipt Match Queue Page

**Route**: `/receipts` (default receipt view)

Table columns:
- ☐ (checkbox)
- Status (badge: pending/classified/approved/applied/rejected)
- Confidence (badge: exact/probable/possible/manual)
- Override (⚠ icon if `overridesExisting`)
- Receipt vendor
- Receipt date
- Receipt amount (formatted dollars)
- Transaction payee
- Transaction date
- Transaction amount
- Line items (count)
- Matched at (timestamp)

Row click → navigates to receipt detail view.

### 7.3 — Receipt Detail Page

**Route**: `/receipts/:id`

Two-column layout:

**Left column — Receipt**:
- Receipt image (if `imageUrl` available; placeholder if 401/403)
- Receipt metadata: vendor, date, total, subtotal, tax, tip, discount, shipping
- Line items table: description, qty, unit price, total price, allocated tax,
  amount with tax, suggested category (dropdown), status (approve/reject buttons)
- "Approve all" / "Reject all" buttons

**Right column — Transaction**:
- Transaction details: payee, date, amount, account, current category, notes
- If `overridesExisting`: prominent warning banner showing current category
  that will be replaced
- Split preview: visual breakdown of proposed subtransactions with category
  names and amounts
- "Apply split" button (disabled until all line items approved)
- "Unmatch" button
- Match history (collapsible timeline)

### 7.4 — Unmatched Receipts Page

**Route**: `/receipts/unmatched`

Same filtering/selection pattern as 7.1. Table shows all receipts with no
match. Each row has a "Match" button that opens a transaction picker modal.

### 7.5 — Unmatched Transactions Page

**Route**: `/transactions/unmatched`

Requires implementing `GET /api/transactions/unmatched`:
- Create a transient Actual Budget API connection
- Fetch all transactions, LEFT JOIN against receipt_matches
- Return those without a match
- Cache results briefly (transactions don't change between fetches)

Table columns: date, payee, amount, account, current category.
Each row has a "Match receipt" button → receipt picker modal.

### 7.6 — Dashboard / Stats Page

**Route**: `/receipts/dashboard`

Summary cards:
- Total receipts fetched
- Matched / unmatched counts
- Status breakdown (pending / classified / approved / applied / rejected)
- Override count (matches that would replace existing categories)
- Recent activity timeline

### 7.7 — Deliverables & Verification

- [x] Receipt match queue with full filtering, sorting, selection, bulk actions
- [x] Receipt detail page with line-item review and split preview
- [x] Unmatched receipts page
- [ ] Unmatched transactions page (deferred — requires Actual Budget API connection per request)
- [x] Dashboard with summary statistics
- [x] Bulk actions trigger batch API endpoints (Phase 6)
- [x] Override warning displayed for already-categorized transactions

**Files**: `src/web/views/receipt-renderer.ts` (new), `src/receipt/receipt-store.ts` (listMatchQueue, getMatchDetail), `src/web/server.ts` (page routes), `src/web/views/renderer.ts` (nav links), `tests/receipt-views.test.ts` (16 tests)
- [ ] Confirmation dialogs for destructive/override actions
- [ ] Responsive layout (works on tablet/desktop)

---

## Phase 7.5: Category Editing & Tax Reconciliation ✅ COMPLETE

Editable category dropdowns on the receipt detail page with live tax
recalculation, DB-backed tax-exempt categories, and original transaction
category display.

**Branch**: `feature/receipt-category-editing`
**PR**: [#3](https://github.com/ExactDoug/actual-ai/pull/3) → `feature/receipt-integration`

### 7.5.1 — DB-Backed Tax-Exempt Categories

- [x] New `tax_exempt_categories` table with case-insensitive prefix matching
- [x] Seeded with 5 NM-specific prefixes (groceries, medical, health, pharmacy, prescription)
- [x] `isCategoryTaxExempt()` uses SQL `LIKE namePrefix || '%' COLLATE NOCASE`
- [x] REST API: GET/POST/DELETE `/api/tax-exempt-categories`
- [x] Replaces hardcoded regex `/^(groceries|medical|health|pharmacy|prescription)/i`

### 7.5.2 — Standalone Tax Reconciler

- [x] Extracted `reconcileMatchTax()` from `line-item-classifier.ts` into `tax-reconciler.ts`
- [x] Uses DB-backed `store.isCategoryTaxExempt()` for taxability inference
- [x] Called from: PATCH endpoint (category change), line-item-classifier (fallback pipeline)
- [x] Returns refreshed classifications array for live UI updates

### 7.5.3 — Click-to-Edit Category Dropdowns

- [x] Category cell: `<span>` with dashed underline + hidden `<select>`
- [x] Click span → show `<select>` populated from cached `/api/categories`
- [x] `<select>` uses `<optgroup>` for category groups
- [x] On change → PATCH `{ categoryId, categoryName }` → server recalculates tax → all rows update

### 7.5.4 — Live Transaction Category Display

- [x] `transactionCategoryId` column added to `receipt_matches` (populated on new matches)
- [x] `GET /api/transactions/:id/details` endpoint for live Actual Budget lookup
- [x] Handles both single-category and already-split (parent with subtransactions) transactions
- [x] Displayed in Matched Transaction card on receipt detail page

### 7.5.5 — Apply Split Budget Connection Fix

- [x] `onReceiptApplySplit` and `onReceiptRollback` wrapped with `createTempApiService()`
- [x] Fixed 500 error: `APIError: No budget file is open` on Apply Split from UI

### 7.5.6 — Apply Button Pulse Animation

- [x] Changed CSS from 2 iterations to `infinite`
- [x] Approve/reject update badges inline (no page reload)
- [x] Auto-pulse on page load when any items already approved

**Files created**: `src/receipt/tax-reconciler.ts`

**Files modified**: `src/receipt/receipt-store.ts` (tax_exempt_categories table, new methods),
`src/receipt/line-item-classifier.ts` (delegate to reconciler, use DB prefixes),
`src/receipt/matching-service.ts` (categoryId passthrough),
`src/web/server.ts` (extended PATCH, tax-exempt endpoints, transaction details),
`src/web/views/receipt-renderer.ts` (dropdowns, live updates, pulse animation),
`app.ts` (budget connection wrappers, categoryId in matching, getTransactionDetails)

---

## Phase 7.6: Transaction Details & Keep-Category Action ✅ COMPLETE

Queue page transaction columns and a "Keep Category" workflow for matches
whose existing Actual Budget category is already correct.

**Commit**: `00c17a8`

### 7.6.1 — Bulk Transaction Lookup

- [x] `getTransactionsBulk()` callback in `app.ts`: opens ONE temp API connection, fetches all transactions/payees/accounts/categories, filters to requested IDs, returns `Record<string, TransactionSummary>`
- [x] Each summary includes: `date`, `payeeName`, `importedPayee`, `accountName`, `categoryId`, `categoryName`, `isParent`, `subtransactions[]`
- [x] Payee UUID → name resolution via `getPayees()` lookup map
- [x] YYYYMMDD integer dates converted to YYYY-MM-DD strings

### 7.6.2 — Bulk Transaction Details Endpoint

- [x] `POST /api/transactions/bulk-details` in `server.ts`
- [x] Accepts `{ transactionIds: string[] }` body (capped at 200)
- [x] `WebServerDeps` interface extended with `getTransactionsBulk` type signature

### 7.6.3 — Queue Page Transaction Columns

- [x] 3 new columns: **Payee**, **Tx Date**, **Category** (inserted into existing table)
- [x] Cells render as `—` initially, populated by lazy-loading IIFE
- [x] `data-tx-id` attribute on each row for DOM targeting
- [x] Split transactions display as "Split: Cat1, Cat2"
- [x] Uncategorized transactions show dimmed `—`

### 7.6.4 — Keep Category Batch Action

- [x] "Keep Category" button in actions bar (olive/gold, between Approve and Apply)
- [x] `POST /api/batch/keep-category` endpoint: sets match status to `applied` without creating classifications or writing to Actual Budget
- [x] Match history recorded with `action: 'keep-category'`, `performedBy: 'user'`
- [x] `batchAction()` JS extended to handle the `keep-category` action path

### 7.6.5 — Unmatch Guard Relaxation

- [x] `matching-service.ts`: unmatch guard changed from `status === 'applied'` to `status === 'applied' && preSplitSnapshot`
- [x] "Kept" matches (applied but no snapshot) can be safely unmatched
- [x] Actually-applied matches (with snapshot) still require rollback first

### 7.6.6 — Detail Page Transaction Fields

- [x] 3 new rows in Matched Transaction card: Payee, Transaction Date, Account
- [x] Extended `getTransactionDetails` response includes `date`, `payeeName`, `accountName`
- [x] Existing live-lookup IIFE populates the new fields

### 7.6.7 — Deliverables & Verification

- [x] Queue page shows payee, date, and category after lazy load completes
- [x] Split transactions display "Split: Cat1, Cat2" in category column
- [x] "Keep Category" sets selected matches to `applied` without AI invocation
- [x] "Kept" matches can be unmatched without requiring rollback
- [x] Detail page shows payee, date, and account in Matched Transaction card
- [x] 176 tests pass (175 + 1 new test for unmatch-on-kept-match)

**Files modified**: `app.ts` (getTransactionsBulk callback, extended getTransactionDetails),
`src/web/server.ts` (bulk-details endpoint, keep-category endpoint, WebServerDeps),
`src/web/views/receipt-renderer.ts` (queue columns, lazy loading, Keep Category button, detail fields),
`src/receipt/matching-service.ts` (unmatch guard relaxation),
`tests/matching-service.test.ts` (split test into with/without snapshot)

---

## Phase 8: Live Testing & Verification ⬜ IN PROGRESS

Test the full pipeline with real data before production deployment.

### 8.1 — Prerequisites

- [ ] Azure AI subscription active (LLM calls)
- [ ] Veryfi credentials configured
- [ ] Actual Budget instance with uncategorized transactions available
- [ ] `dryRun` enabled for initial testing (suggestions only, no auto-apply)

### 8.2 — Veryfi End-to-End

- [x] Fetch receipts from Veryfi API (31 receipts fetched successfully)
- [x] TOTP auth with anti-replay works
- [x] Receipt data stored correctly in SQLite
- [x] Near-duplicate detection logs warnings

### 8.3 — Matching Verification

- [x] Matching runs against real Actual Budget transactions
- [x] Date parsing handles Actual Budget integer format
- [x] Vendor normalization matches real-world payee names
- [x] Payee UUID resolution works via `getPayees()`
- [ ] Verify correct matches with fresh uncategorized transactions
  (current test data has no uncategorized transactions from receipt date range)
- [ ] Verify `overridesExisting` flag on already-categorized transactions

### 8.4 — Line-Item Classification

- [x] LLM classifies line items from a real receipt (Albertsons 7 items, Dollar Tree 15 items, Safeway 4 items)
- [x] Structured output (JSON schema) produces valid, parseable responses
- [x] Tax allocation produces correct amounts (proportional distribution verified)
- [x] Classifications stored with correct category IDs (UUIDs from Actual Budget)
- [ ] Re-classification works on already-classified matches

### 8.4.1 — Fallback Classification Pipeline

- [ ] Tier 1: web search + individual LLM upgrades a low-confidence item
  (SERP not enabled in production — neither `webSearch` nor `freeWebSearch` feature flags set)
- [ ] Search query includes item description + vendor name
- [ ] Fallback prompt includes search results and receipt context
- [ ] Tier 2: rules engine matches an item description to a rule
- [x] Tier 3: majority category assigned when other items are classified
  (verified: BLMNG UPGRADE 6" → Groceries via majority at Albertsons)
- [ ] 1-2 item receipt special case uses whole-transaction pipeline
- [x] `notes` column records fallback path for each item
  (verified: `fallback:tier3:majority-category` in DB)
- [ ] `RECEIPT_FALLBACK_WEB_SEARCH=false` correctly skips Tier 1

### 8.4.2 — Tax Reconciliation After Fallback

- [x] Post-LLM taxability inferred from category names
  (groceries/Rx → tax-exempt, all other → taxable)
- [x] Tax recomputed after fallback pipeline changes categories
- [x] `reconcileTax()` correctly updates allocatedTax, amountWithTax, taxable
  (verified: Albertsons item 6 "Groceries" → taxable=0, allocatedTax=0)
- [x] All-exempt edge case falls back to proportional allocation
- [x] Balance discrepancy adjustment applied after reconciliation

### 8.5 — Split Transaction Verification

- [x] Apply split: budget connection established before API calls (e956f1f)
- [ ] Apply split: original transaction replaced with subtransactions (end-to-end)
- [ ] Transaction ID behavior documented (preserved or remapped)
- [ ] Rollback: original transaction restored from snapshot
- [ ] `#actual-ai-receipt` tag appended/removed correctly

### 8.6 — Review UI Workflow

- [x] Full workflow via UI: view matches → classify → approve → apply (verified 2026-03-13)
- [x] Category editing via click-to-edit dropdowns (verified 2026-03-13)
- [x] Live tax recalculation after category change (verified 2026-03-13)
- [x] Current transaction category displayed in Matched Transaction card
- [x] Queue page transaction columns (payee, date, category) via lazy loading (verified 2026-03-13)
- [x] "Keep Category" workflow verified — marks matches as applied without AI (verified 2026-03-13)
- [x] Detail page shows payee, date, and account in Matched Transaction card (verified 2026-03-13)
- [ ] Unmatch/rematch from UI
- [ ] Bulk operations via UI
- [ ] Override approval gate works for already-categorized transactions

---

## Phase 9: Production Deployment ⬜ NOT STARTED

### 9.1 — Build & Push

- [ ] Build Docker image from `feature/receipt-integration` branch
- [ ] Push to Harbor (`hr01.exactpartners.com/apps/actual-ai`)
- [ ] Tag as `receipt-integration` (not `latest` until verified)

### 9.2 — Deploy to dh01

- [ ] Update container env vars:
  - Add `receiptMatching`, `lineItemClassification` to FEATURES
  - Add `RECEIPT_CONNECTORS=veryfi`
  - Add Veryfi credentials
  - Keep `dryRun` enabled initially
- [ ] Pull and restart container with new image
- [ ] Verify receipt fetch runs on startup
- [ ] Verify Review UI accessible with receipt pages

### 9.3 — Production Verification

- [ ] Monitor first few classification runs
- [ ] Verify matches against live transaction data
- [ ] Test approve + apply workflow on a real transaction
- [ ] Verify rollback works in production
- [ ] Remove `dryRun` from FEATURES when confident (or keep as `requireApproval`)

---

## Implementation Order

```
Phases 1-5.5 ✅ COMPLETE
     |
     ├── Phase 5.5: Fallback Classification Pipeline ✅
     |     (web search + individual LLM, rules, majority, manual review)
     |
     ├── Phase 6: Batch Operations ✅
     |     (batch endpoints, re-classification, batch service)
     |
     ├── Phase 7: Review UI — Receipt Views ✅
     |     (filtering, selection, bulk actions, detail pages)
     |
     ├── Phase 7.5: Category Editing & Tax Reconciliation ✅
     |     (click-to-edit dropdowns, DB-backed tax-exempt categories,
     |      live tax recalc, transaction category display, apply fix)
     |
     ├── Phase 7.6: Transaction Details & Keep-Category ✅
     |     (queue payee/date/category columns, bulk lookup,
     |      keep-category action, unmatch guard relaxation)
     |
     └── Phase 8: Live Testing ⬜ IN PROGRESS
           (partially verified — apply, category editing, keep-category confirmed)
           |
           └── Phase 9: Production Deployment
                 (after Phase 8 complete)
```

Phase 5.5 should be implemented first — the batch classification in Phase 6
needs the fallback chain to run automatically for low-confidence items.
Phases 6 and 7 can then be developed in parallel.

---

## Key Risk Areas

1. **Transaction ID preservation on delete + re-create** — Must verify with
   `@actual-app/api` during Phase 8. If IDs change, reference remapping
   logic is needed. Test this early with a throwaway transaction.

2. **Veryfi TOTP anti-replay** — The `waitForFreshTotp()` mechanism works but
   adds up to 30s latency on re-auth. If the cron job runs every 4 hours this
   is fine; if triggered manually in quick succession, users may notice delay.

3. **46% receipt amount mismatch** — Nearly half of Veryfi receipts have
   `total ≠ subtotal + tax + tip - discount`. The tax allocator adjusts the
   largest item to force balance, but large adjustments should be logged
   prominently so users can investigate.

4. **Actual Budget API limitations** — `updateTransaction()` doesn't support
   `subtransactions`. The delete + re-create approach works but is destructive.
   Pre-split snapshots are the safety net.

5. **SQLite concurrency** — Receipt store and classification store are
   separate databases. The data dir lock prevents concurrent classification
   runs, but the Review UI reads/writes concurrently. WAL mode handles
   this for reads; write contention is minimal (only user actions).

6. **Batch operation safety** — Batch classify/apply could trigger many LLM
   calls or many Actual Budget writes. The `limit` parameter (default 50,
   max 200) prevents runaway operations. Batch apply on `overridesExisting`
   matches should require explicit confirmation.
