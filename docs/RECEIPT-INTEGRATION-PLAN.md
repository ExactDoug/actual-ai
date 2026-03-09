# Receipt Integration — Implementation Plan

**Spec**: `docs/RECEIPT-INTEGRATION-REQUIREMENTS.md`
**Branch**: `feature/receipt-integration`
**Depends on**: Veryfi TypeScript client (`src/veryfi/`) — already complete

---

## Phase 1: Foundation

Build the receipt connector framework, wire the Veryfi adapter, and persist
fetched receipts in SQLite. No matching or classification yet — just fetch and
store.

### 1.1 — Configuration & Feature Flags

**Files**: `src/config.ts`

- Add env vars: `RECEIPT_CONNECTORS`, `VERYFI_USERNAME`, `VERYFI_PASSWORD`,
  `VERYFI_TOTP_SECRET`, `RECEIPT_MATCH_TOLERANCE_CENTS` (default 5),
  `RECEIPT_DATE_TOLERANCE_DAYS` (default 1), `RECEIPT_AUTO_MATCH` (default
  true), `RECEIPT_FETCH_DAYS_BACK` (default 30), `RECEIPT_TAG` (default
  `#actual-ai-receipt`)
- Register feature flags: `receiptMatching`, `lineItemClassification`,
  `autoSplitTransactions`
- Add flag dependency validation on startup: `lineItemClassification` requires
  `receiptMatching`; `autoSplitTransactions` requires both. Log warning and
  disable dependent flag if unsatisfied.

### 1.2 — Receipt Store (SQLite)

**New file**: `src/receipt/receipt-store.ts`

Extend the existing `better-sqlite3` pattern from `classification-store.ts`:

- Create tables: `receipts`, `receipt_matches`, `receipt_match_history`,
  `line_item_classifications` (schema from spec Section 10)
- Create view: `transaction_receipt_status`
- All FKs with `ON DELETE CASCADE`; enable `PRAGMA foreign_keys = ON`
- DB path: `${dataDir}/receipts.db` (separate from classifications.db)
- Methods:
  - `upsertReceipt(receipt)` — insert or update by (providerId, externalId)
  - `getReceipt(id)`, `getReceiptByExternalId(providerId, externalId)`
  - `listReceipts(filter)` — paginated, filterable
  - `findNearDuplicates(vendorName, date, totalAmount, toleranceCents)` —
    for near-duplicate detection warning
  - `createMatch(transactionId, receiptId, confidence)`
  - `updateMatchStatus(matchId, status)`
  - `getMatchesForTransaction(transactionId)`
  - `getUnmatchedReceipts()`, `getUnmatchedTransactions(allTransactionIds)`
  - `insertMatchHistory(entry)`
  - `getMatchHistory(receiptId)`
  - `insertLineItemClassification(record)`
  - `getClassificationsForMatch(matchId)`
  - `updateLineItemStatus(id, status)`
  - `getStats()` — counts by match status

### 1.3 — Receipt Connector Interface

**New file**: `src/receipt/connector.ts`

```typescript
interface ReceiptConnector {
  readonly providerId: string;
  fetchReceipts(since: Date): Promise<{
    receipts: ReceiptDocument[];
    errors: Array<{ message: string; context?: unknown }>;
  }>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
}
```

**New file**: `src/receipt/connector-registry.ts`

- Registry maps `providerId` → `ReceiptConnector` instance
- `register(connector)`, `get(id)`, `getAll()` methods
- Initialized from `RECEIPT_CONNECTORS` env var (comma-separated list)

### 1.4 — Veryfi Adapter

**New file**: `src/receipt/veryfi-adapter.ts`

Adapter that implements `ReceiptConnector`, wrapping the existing Veryfi
client (`src/veryfi/client.ts`):

- `providerId: "veryfi"`
- `fetchReceipts(since)`:
  - Call `VeryfiClient.getReceipts({ createdGte: since })`
  - Map each `VeryfiReceipt` → `ReceiptDocument` (spec Section 3.3):
    - `date` ← `stamp_date` (OCR date), NOT `date`/`created`
    - `totalAmount` ← `Math.round(total * 100)` (dollars→cents)
    - `vendorName` ← `business_name`
    - `vendorId` ← `String(business_id)` (numeric→string)
    - Line items: use `.total` not `.price` (84% zero rate on price)
    - Tax from receipt level only (line-item tax is always 0)
  - Return `{ receipts, errors }` — partial failures logged, not thrown
  - Near-duplicate detection: check `receipt-store.findNearDuplicates()`
    before insert; log warning but still insert
- `testConnection()`: call `VeryfiClient.healthCheck()`
- Auth credentials from config: `VERYFI_USERNAME`, `VERYFI_PASSWORD`,
  `VERYFI_TOTP_SECRET`

### 1.5 — Receipt Types

**New file**: `src/receipt/types.ts`

TypeScript interfaces from spec Section 3.2:
- `ReceiptDocument` — normalized receipt with all amounts in cents
- `ReceiptLineItem` — individual line item
- `ReceiptMatch` — transaction-to-receipt match record
- `ReceiptMatchHistory` — audit trail entry
- `LineItemClassification` — per-item classification result
- `MatchConfidence`: `'exact' | 'probable' | 'possible' | 'manual'`
- `MatchStatus`: `'pending' | 'classified' | 'approved' | 'applied' | 'rejected'`

### 1.6 — Receipt Fetch Service

**New file**: `src/receipt/receipt-fetch-service.ts`

Orchestrates the fetch-and-store cycle:

- `fetchAll()`:
  - For each connector in registry: call `fetchReceipts(since)`
  - `since` = now minus `RECEIPT_FETCH_DAYS_BACK` days
  - Upsert each receipt into `receipt-store`
  - Return summary: `{ fetched, new, updated, errors }`

### 1.7 — Wire Into App

**Files**: `src/container.ts`, `app.ts`

- In `container.ts`: create `ReceiptStore`, `ConnectorRegistry`,
  `VeryfiAdapter`, `ReceiptFetchService`
- In `app.ts`: add receipt fetch to the classification cron job (fetch
  receipts before running classification)
- Add `receiptMatching` feature flag gate — skip all receipt logic if disabled

### 1.8 — Deliverables & Verification

- [x] `npm run build` passes
- [x] Feature flags register correctly; dependency validation works
- [x] Receipt store creates tables on first run
- [ ] Veryfi adapter fetches and stores receipts (test with live API)
- [x] Near-duplicate warning logged for same vendor/date/amount
- [x] Receipts persist across restarts (SQLite on disk)

---

## Phase 2: Transaction-to-Receipt Matching

### 2.1 — Matching Algorithm

**New file**: `src/receipt/matching-service.ts`

Implements spec Section 4.1:

- `matchReceipts(transactions, receipts)` → `MatchResult[]`
- For each unmatched receipt, score against each unmatched transaction:
  - **Amount** (weight: High): `|receipt.totalAmount - abs(transaction.amount)|`
    ≤ `RECEIPT_MATCH_TOLERANCE_CENTS` → strong signal
  - **Date** (weight: Medium): `|receipt.date - transaction.date|`
    ≤ `RECEIPT_DATE_TOLERANCE_DAYS` → positive signal
  - **Vendor** (weight: Low-Medium): fuzzy match receipt.vendorName against
    transaction.payee/imported_payee. Use `business_id` for reliable vendor
    dedup when available.
- Confidence scoring:
  - `exact`: amount within tolerance AND date match AND vendor match
  - `probable`: amount within tolerance AND (date OR vendor match)
  - `possible`: amount within tolerance only
- Exclude zero-amount transactions and receipts from matching
- Auto-confirm `exact` matches when `RECEIPT_AUTO_MATCH` is true
- One receipt per transaction (1:1); if multiple candidates, pick highest score
- Handle ambiguity: multiple receipts → same transaction = flag for manual review

### 2.2 — Unmatched Item Tracking

Built into `receipt-store.ts` methods (Phase 1.2):

- `getUnmatchedReceipts()` — receipts with no row in `receipt_matches`
- `getUnmatchedTransactions(allTransactionIds)` — transaction IDs not in
  `receipt_matches`

### 2.3 — Match Persistence

**File**: `src/receipt/receipt-store.ts` (extend)

- `createMatch()` stores match with confidence and status
- `insertMatchHistory()` for audit trail
- Auto-set status to `pending` (awaiting classification)

### 2.4 — Wire Matching Into Pipeline

**Files**: `src/actual-ai.ts` or `app.ts`

After receipt fetch (Phase 1), before classification:
1. Fetch all unmatched receipts from store
2. Fetch uncategorized transactions from Actual Budget
3. Run matching algorithm
4. Persist matches
5. Log summary: X exact, Y probable, Z possible, W unmatched

### 2.5 — Deliverables & Verification

- [x] Matching produces correct confidence levels for known receipt/transaction pairs
- [x] Exact matches auto-confirm when `RECEIPT_AUTO_MATCH=true`
- [x] Zero-amount items excluded
- [x] Ambiguous matches flagged (not auto-resolved)
- [x] Match history audit trail records all operations
- [x] Unmatched pools queryable from store

---

## Phase 3: Line-Item Classification

### 3.1 — Line-Item Prompt Template

**New file**: `src/templates/line-item-prompt.hbs`

Handlebars template from spec Section 5.4:
- Vendor name, date, account context
- All line items with description, qty, price
- Additional charges (tip, fee, shipping)
- Category groups and categories list
- Expected JSON array response format

### 3.2 — Tax Allocation Algorithm

**New file**: `src/receipt/tax-allocator.ts`

Implements spec Section 5.2:
- Input: line items (with totalPrice, taxable flag), totalTax
- Order of operations: discount → tax → tip/shipping/fee
- Handles: zero tax, zero total, taxable vs non-taxable items,
  proportional distribution, deficit rounding to largest item
- Validation assertion: sum of allocated amounts + charges = receipt total
- Log discrepancy for the 46% of Veryfi receipts that don't reconcile;
  adjust largest item to force balance

### 3.3 — Line-Item Classifier

**New file**: `src/receipt/line-item-classifier.ts`

- `classifyItems(receipt, transaction, categories)` → `LineItemClassification[]`
- Build prompt using `line-item-prompt.hbs`
- Send to LLM via existing `LlmService`
- Parse JSON array response: `{ itemIndex, type, categoryId, confidence }`
- Batch: all items from one receipt in a single LLM call
- Apply tax allocation to produce final amounts with tax
- Handle additional charges (tip/shipping/fee as separate subtransactions)
- Store results in `line_item_classifications` table

### 3.4 — Fallback Behavior

**File**: `src/receipt/line-item-classifier.ts`

Spec Section 5.5:
- **0 line items** (6% of Veryfi corpus): skip line-item pipeline, use
  existing whole-transaction classification
- **Low-confidence items**: secondary classification with web search on
  item description; then whole-transaction fallback; then majority-category
  fallback; then null + pending for manual review
- **1-2 item receipts with low confidence**: fall back to whole-transaction
  classification (don't split)

### 3.5 — Wire Into Pipeline

After matching (Phase 2), for each matched receipt with status `pending`:
1. Check if receipt has line items (skip if 0)
2. Run line-item classifier
3. Store classifications
4. Update match status to `classified`

### 3.6 — Deliverables & Verification

- [ ] Line-item prompt generates valid LLM request
- [ ] Tax allocation produces correct amounts (test with spec's Walmart example)
- [ ] Rounding adjustment works (remainder applied to largest item)
- [ ] Fallback chain: low confidence → web search → whole-tx → majority → null
- [ ] 0-line-item receipts skip classification
- [ ] Classifications stored in SQLite with correct amounts

---

## Phase 4: Split Transaction Service

### 4.1 — Split Transaction Service

**New file**: `src/receipt/split-transaction-service.ts`

Implements spec Section 6.2:

- `createSplit(plan: SplitPlan)`:
  1. Snapshot original transaction → `receipt_matches.preSplitSnapshot`
  2. Delete original transaction
  3. Re-create via `importTransactions()` with `subtransactions[]`
  4. Preserve: id, date, payee, account, imported_payee, notes, cleared/reconciled
  5. Append `RECEIPT_TAG` to notes
  6. **Verify ID preservation** — if ID changes, update all references
- `rollbackSplit(matchId)`:
  1. Read `preSplitSnapshot` from match record
  2. Delete the split transaction
  3. Re-create original from snapshot
  4. Remove `RECEIPT_TAG` from notes
  5. Update match status

### 4.2 — Actual API Extensions

**File**: `src/actual-api-service.ts`

Add methods:
- `deleteTransaction(id)` — needed for delete + re-create pattern
- `importTransactionsWithSplits(accountId, transactions)` — wrapper around
  `importTransactions()` that includes `subtransactions` field
- `getTransactionById(id)` — fetch single transaction for snapshot

### 4.3 — SplitPlan Builder

**New file**: `src/receipt/split-plan-builder.ts`

Converts classified line items + tax allocation into a `SplitPlan`:
- One `SplitEntry` per classified line item (amount = `amountWithTax` in cents)
- Additional entries for tip/shipping/fee
- Validate: sum of splits = original transaction amount
- Adjust largest split if rounding difference

### 4.4 — Safeguards

**File**: `src/receipt/split-transaction-service.ts`

- Never split an already-split transaction (`is_parent` check)
- Never split a reconciled transaction without user confirmation
  (defer to Review UI — don't auto-apply reconciled)
- Verify subtransaction amounts sum to parent
- Store pre-split snapshot for rollback

### 4.5 — Deliverables & Verification

- [ ] Split creation produces correct subtransactions in Actual Budget
- [ ] Transaction ID behavior documented and handled (preserved or remapped)
- [ ] `RECEIPT_TAG` appended on split, removed on rollback
- [ ] Pre-split snapshot stores complete transaction state
- [ ] Rollback restores original transaction accurately
- [ ] Already-split and reconciled transactions rejected

---

## Phase 5: Review UI Extensions

### 5.1 — Receipt API Endpoints

**File**: `src/web/server.ts`

Add routes from spec Sections 4.5 and 7.3:

```
GET    /api/receipts                     — list receipts with match status
GET    /api/receipts/:id                 — single receipt with line items
POST   /api/receipts/fetch               — trigger receipt fetch
POST   /api/receipts/:id/match           — manual match (body: { transactionId })
GET    /api/receipts/:id/splits          — preview proposed split
POST   /api/receipts/:id/classify        — trigger line-item classification
POST   /api/receipts/:id/apply           — apply split to Actual Budget
GET    /api/transactions/unmatched       — unmatched transactions
GET    /api/receipts/unmatched           — unmatched receipts
POST   /api/matches/:id/unmatch          — remove match (rollback if applied)
POST   /api/matches/:id/rematch          — rematch (body: { transactionId })
GET    /api/matches/:id/history          — match audit trail
GET    /api/connectors                   — list configured connectors
POST   /api/connectors/:id/test          — test connector connectivity
```

### 5.2 — Receipt Match Review Page

**File**: `src/web/views/renderer.ts` (extend)

New pages/views:
- **Receipt match queue**: table of matched receipts with status, confidence,
  vendor, amount, date. Actions: approve, reject, rematch.
- **Unmatched transactions**: filterable list with manual-match action
- **Unmatched receipts**: filterable list with manual-match action
- **Receipt detail view**: line items, tax, proposed split preview side-by-side
  with the transaction. Receipt image (with 401/403 fallback placeholder).
- **Split preview**: visual breakdown of how the transaction will be split

### 5.3 — Line-Item Review Actions

Per line-item:
- Approve/reject suggested category
- Change category (dropdown from Actual Budget categories)
- Merge two adjacent line items (UI-only: concatenate descriptions, sum
  amounts, record in notes field)

Batch:
- Approve all items on a receipt
- Reject entire match

### 5.4 — Deliverables & Verification

- [ ] All API endpoints return correct data
- [ ] Receipt detail view renders line items and tax breakdown
- [ ] Split preview shows accurate amounts
- [ ] Manual match workflow: select unmatched receipt + transaction → create match
- [ ] Unmatch rolls back applied splits correctly
- [ ] Rematch workflow: unmatch old → match new → re-classify
- [ ] Image URL 401/403 shows placeholder with re-fetch option
- [ ] Match history audit trail visible

---

## Implementation Order & Dependencies

### Phase 1 internal order

Steps 1.1 (config) and 1.5 (types) have no dependencies — do them first.
Then 1.2 (store) and 1.3 (connector interface) can be done in parallel
(both depend only on types). Then 1.4 (Veryfi adapter) needs 1.3. Then
1.6 (fetch service) needs 1.2 + 1.3. Finally 1.7 (wire into app) is last.

### After Phase 1: three parallel workstreams

```
                      Phase 1
                         |
           ┌─────────────┼──────────────┐
           v             v              v
      [Stream A]    [Stream B]     [Stream C]
       Phase 2      3.1 Prompt     4.2 API extensions
       Matching     3.2 Tax alloc  5.1 Read-only API
                                    endpoints
           |             |
           v             v
           └──────┬──────┘
                  v
             Phase 3 wiring
             (3.3–3.5)
                  |
                  v
             Phase 4
             (4.1, 4.3–4.4)
                  |
                  v
             Phase 5 remaining
             (write endpoints + UI views)
```

**Stream A — Matching (Phase 2):** Needs Phase 1 store and types.
Pure scoring algorithm plus pipeline wiring.

**Stream B — Pure logic (no runtime deps):**
- 3.1 Prompt template — Handlebars only, needs types for context vars.
- 3.2 Tax allocator — pure math, unit-testable in isolation.

**Stream C — API scaffolding (no matching/classification deps):**
- 4.2 Actual API extensions (`deleteTransaction`, `getTransactionById`,
  `importTransactionsWithSplits`) — new methods on existing service.
- 5.1 Read-only receipt endpoints (`GET /api/receipts`,
  `GET /api/receipts/unmatched`, `GET /api/transactions/unmatched`,
  `GET /api/connectors`, `POST /api/connectors/:id/test`) — just
  query the receipt store.

**After streams converge:**
- Phase 3 wiring (3.3–3.5) needs Stream A (matches exist) + Stream B
  (prompt + tax allocator ready).
- Phase 4 (4.1, 4.3–4.4) needs Phase 3 (classified line items) +
  Stream C (API extensions).
- Phase 5 remaining (write endpoints, split preview, UI views) needs
  Phase 4 (splits operational).

### Estimated New Files

| Phase | New Files | Modified Files |
|-------|-----------|----------------|
| 1 | 6 (`connector.ts`, `connector-registry.ts`, `veryfi-adapter.ts`, `receipt-store.ts`, `receipt-fetch-service.ts`, `types.ts`) | 3 (`config.ts`, `container.ts`, `app.ts`) |
| 2 | 1 (`matching-service.ts`) | 2 (`receipt-store.ts`, `app.ts`) |
| 3 | 3 (`line-item-classifier.ts`, `tax-allocator.ts`, `line-item-prompt.hbs`) | 1 (`app.ts`) |
| 4 | 2 (`split-transaction-service.ts`, `split-plan-builder.ts`) | 1 (`actual-api-service.ts`) |
| 5 | 0 | 2 (`server.ts`, `renderer.ts`) |

All new files in `src/receipt/` except the prompt template (`src/templates/`).

---

## Git Workflow

**Branch**: `feature/receipt-integration` (from `master`)

Commit at the end of each numbered step within a phase. Each phase gets
its own PR into `master` so changes are reviewable in manageable chunks.

| Phase | Branch | PR into |
|-------|--------|---------|
| 1 | `feature/receipt-integration` | `master` |
| 2 | `feature/receipt-matching` | `master` |
| 3 | `feature/receipt-classification` | `master` |
| 4 | `feature/receipt-splits` | `master` |
| 5 | `feature/receipt-review-ui` | `master` |

Each PR should pass `npm run build` and any existing tests before merge.
Add unit tests for new logic (tax allocator, matching scorer) within the
same phase.

---

## Key Risk Areas

1. **Transaction ID preservation on delete + re-create** — Must verify with
   `@actual-app/api` during Phase 4. If IDs change, reference remapping
   logic is needed. Test this early with a throwaway transaction.

2. **Veryfi TOTP anti-replay** — The `waitForFreshTotp()` mechanism works but
   adds up to 30s latency on re-auth. If the cron job runs every 4 hours this
   is fine; if triggered manually in quick succession, users may notice the delay.

3. **46% receipt amount mismatch** — Nearly half of Veryfi receipts have
   `total ≠ subtotal + tax + tip - discount`. The validation assertion
   adjusts the largest item to force balance, but large adjustments should
   be logged prominently so users can investigate.

4. **Actual Budget API limitations** — `updateTransaction()` doesn't support
   `subtransactions`. The delete + re-create approach works but is destructive.
   Pre-split snapshots are the safety net.

5. **SQLite concurrency** — Receipt store and classification store are
   separate databases. The data dir lock prevents concurrent classification
   runs, but the Review UI reads/writes concurrently. WAL mode handles
   this for reads; write contention is minimal (only user actions).
