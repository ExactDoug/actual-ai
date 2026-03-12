# Receipt Integration — Implementation Plan

**Spec**: `docs/RECEIPT-INTEGRATION-REQUIREMENTS.md`
**Branch**: `feature/receipt-integration`
**Depends on**: Veryfi TypeScript client (`src/veryfi/`) — complete

**Last updated**: 2026-03-12

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
- [x] Tax allocation: proportional distribution with taxable flags, rounding
- [x] Receipt balance validation with discrepancy adjustment
- [x] LLM-based classification of individual line items
- [x] Fallback chain: low confidence → fallback type
- [x] Classifications stored in `line_item_classifications` table

**Files created**: `src/receipt/tax-allocator.ts`,
`src/receipt/line-item-classifier.ts`, `src/templates/line-item-prompt.hbs`

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

## Phase 6: Batch Operations ⬜ NOT STARTED

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

- [ ] All 6 batch endpoints functional
- [ ] Filter-based selection works with all filter fields
- [ ] Explicit matchIds selection works
- [ ] Re-classification deletes old classifications and re-runs LLM
- [ ] Partial failures don't abort the batch (each item independent)
- [ ] Limit parameter prevents runaway batch operations
- [ ] Unit tests for batch service filter resolution and error collection

---

## Phase 7: Review UI — Receipt Views ⬜ NOT STARTED

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

- [ ] Receipt match queue with full filtering, sorting, selection, bulk actions
- [ ] Receipt detail page with line-item review and split preview
- [ ] Unmatched receipts page with manual match workflow
- [ ] Unmatched transactions page (requires API implementation)
- [ ] Dashboard with summary statistics
- [ ] Bulk actions trigger batch API endpoints (Phase 6)
- [ ] Override warning displayed for already-categorized transactions
- [ ] Confirmation dialogs for destructive/override actions
- [ ] Responsive layout (works on tablet/desktop)

---

## Phase 8: Live Testing & Verification ⬜ NOT STARTED

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

- [ ] LLM classifies line items from a real receipt
- [ ] Tax allocation produces correct amounts
- [ ] Classifications stored with correct category IDs
- [ ] Re-classification works on already-classified matches

### 8.5 — Split Transaction Verification

- [ ] Apply split: original transaction replaced with subtransactions
- [ ] Transaction ID behavior documented (preserved or remapped)
- [ ] Rollback: original transaction restored from snapshot
- [ ] `#actual-ai-receipt` tag appended/removed correctly

### 8.6 — Review UI Workflow

- [ ] Full workflow via UI: view matches → classify → approve → apply
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
Phases 1-5 ✅ COMPLETE
     |
     ├── Phase 6: Batch Operations
     |     (batch endpoints, re-classification, batch service)
     |
     ├── Phase 7: Review UI — Receipt Views
     |     (filtering, selection, bulk actions, detail pages)
     |     (depends on Phase 6 for bulk action backends)
     |
     └── Phase 8: Live Testing
           (can start in parallel with Phases 6-7 for API-level testing)
           |
           └── Phase 9: Production Deployment
                 (after Phases 6-8 complete)
```

Phases 6 and 7 can be developed in parallel (API first, then UI that calls
those APIs). Phase 8 testing of the existing individual endpoints can begin
immediately; batch and UI testing depends on Phases 6-7.

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
