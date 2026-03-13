# Receipt Integration — Current State Document

**Date**: 2026-03-13
**Branch**: `feature/receipt-integration`
**Base**: `master`
**PR**: [#2](https://github.com/ExactDoug/actual-ai/pull/2) (open)
**Commits on branch**: 35 (from `6010f7f` through `664e9b7`)
**Deployed**: Yes — running on dh01 as `actual-ai` container
**Image**: `hr01.exactpartners.com/apps/actual-ai:feature-receipt-integration`
**FQDN**: `actual-ai.dandelionfieldsnm.com` (Caddy reverse proxy on dh01)

---

## 1. Executive Summary

The receipt/OCR integration for actual-ai has been implemented across Phases
1-7 of the plan and is now **deployed to production on dh01**. The system is
running with `dryRun` enabled for the standard transaction classifier, but the
receipt pipeline is independently gated by manual approval and is functional
end-to-end.

All 175 tests pass across 22 test suites. The full `npm run build` succeeds
with zero errors.

The system can now:
- Fetch receipts from Veryfi (or any future OCR provider) via a pluggable connector
- Match receipts to Actual Budget transactions using multi-signal scoring
- Classify individual line items on matched receipts via LLM with structured
  output (JSON schema enforcement via `generateObject()` + Zod)
- Run a 4-tier fallback pipeline for low-confidence items
- Distribute tax proportionally across line items
- Apply single-item receipt categories directly (no split needed)
- Convert multi-item transactions into split transactions with per-item categories
- Roll back splits to restore the original transaction
- Review all of the above via server-rendered HTML pages with filtering, bulk actions

The integration is gated behind the `receiptMatching` feature flag and is
completely dormant unless explicitly enabled.

---

## 2. Branch & Commit History

```
664e9b7 fix: correct boolean binding in updateLineItemClassification for SQLite
9be07b0 fix: reconcile tax allocation after fallback pipeline changes categories
11343de fix: infer taxability from LLM category assignments for tax allocation
9228b93 fix: remove per-item taxability inference, pass receipt tax total instead
e09ebbb fix: add OTC medicine taxability note to LLM prompt
349c935 fix: restore detailed classification instructions and JSON example
f69f083 refactor: condense LLM prompt to reduce token usage
630277b feat: add prescription medicine tax hint to LLM prompt
0ad3deb feat: pass taxability as classification hint to LLM prompt
647d7c2 fix: default to taxable=true when Veryfi type field is missing
68fb99e fix: infer line-item taxability from Veryfi type field
a6e5b32 fix: display totalPrice instead of unitPrice in receipt detail view
068f5f1 fix: auto-promote match status when all line items approved individually
68be8f9 feat: single-item category apply + apply button pulse animation
6af9657 docs: update plan with Phase 7 complete status
bf879db fix: ensure apply/ data dir exists before Actual Budget API init
906171a fix: lint fixes and correct jest config to exclude dist/ duplicates
ebd4112 feat: add receipt Review UI views with filtering, detail, and dashboard (Phase 7)
d4c9235 feat: add batch operations and re-classification support (Phase 6)
206a5a6 feat: add fallback classification pipeline for low-confidence line items (Phase 5.5)
e094aa7 docs: sync state and requirements docs with current status
19a64c3 docs: add fallback classification pipeline spec (Phase 5.5)
e9f1966 feat: use structured output (JSON schema) for line-item classification
bffead2 fix: LLM line-item classification JSON parsing
b9a7f8d docs: update plan with Phases 6-9 and sync state document
8263010 feat: match receipts to already-categorized transactions with approval gate
95d86a5 fix: matching service date parsing, vendor normalization, and payee resolution
895ff8d test: add unit tests for tax-allocator, matching-service, and split-plan-builder
7723c4c fix: ensure receipt store creates data directory if missing
a5a6e32 feat: add line-item classifier, split transactions, and receipt API endpoints (Phases 3-5)
84e2ebf feat: add matching service, tax allocator, API extensions, receipt endpoints (Phase 2 + streams B/C)
c52558d feat: add receipt connector framework and Veryfi adapter (Phase 1)
3aca8c1 fix: add TOTP anti-reuse guard to Veryfi auth
97f887f feat: add Veryfi receipt integration requirements and TypeScript client
6010f7f feat: add Review UI for classification approval workflow
```

Branch is pushed to remote. PR #2 is open against `master`.

---

## 3. Production Deployment Status

### Container Configuration

| Setting | Value |
|---------|-------|
| Container | `actual-ai` |
| Image | `hr01.exactpartners.com/apps/actual-ai:latest` |
| Network | `isolated-services` |
| Volume | `actual-ai-data:/tmp/actual-ai` |
| Restart | `unless-stopped` |
| Port | 3000 (internal, via Caddy) |

### Environment Variables

| Variable | Value |
|----------|-------|
| `ACTUAL_SERVER_URL` | `http://actual-budget:5006` (container-to-container) |
| `ACTUAL_BUDGET_ID` | `0dfea2f4-e989-4099-bb8d-9d297b1b8f43` |
| `LLM_PROVIDER` | `openai` |
| `OPENAI_MODEL` | `gpt-4.1` |
| `OPENAI_BASE_URL` | Azure endpoint (westus3) |
| `CLASSIFICATION_SCHEDULE_CRON` | `0 */4 * * *` |
| `FEATURES` | `["classifyOnStartup", "syncAccountsBeforeClassify", "dryRun", "receiptMatching", "lineItemClassification"]` |
| `RECEIPT_CONNECTORS` | `veryfi` |
| `VERYFI_USERNAME` | configured |
| `VERYFI_PASSWORD` | configured |
| `VERYFI_TOTP_SECRET` | configured |

### First Production Run Results

- **Receipt fetch**: 27 receipts from Veryfi, 0 errors (all 27 were near-duplicates from prior testing)
- **Receipt matching**: 17 matched (8 probable, 9 possible), 10 unmatched, 0 exact
- **Transaction classification**: 2,838 uncategorized transactions processed in dry run mode
- **No crashes**: The `apply/` directory ENOENT bug was fixed (`bf879db`)

---

## 4. Architecture Overview

### Pipeline Flow

```
Veryfi OCR → Receipt Fetch → Receipt Store (SQLite)
                                    ↓
Actual Budget API → Transaction Fetch → Matching Service
                                              ↓
                                    Receipt Matches (SQLite)
                                              ↓
                              Line Item Classifier (LLM)
                                              ↓
                        Infer taxability from category names
                        (NM rules: groceries/Rx exempt)
                                              ↓
                        Tax allocation (taxable items only)
                                              ↓
                              Line Item Classifications (SQLite)
                                              ↓
                              Fallback Pipeline (4 tiers)
                                              ↓
                        Tax reconciliation (re-infer + reallocate)
                                              ↓
                     Review UI → Approve/Reject → Apply
                                              ↓
                              Actual Budget API (update/split)
```

### Key Design Decisions

1. **Two SQLite databases**: `classifications.db` (original transaction classifier) and `receipts.db` (receipt pipeline) — separate concerns, no migration conflicts
2. **Receipt pipeline is independent of dryRun**: The `dryRun` flag gates the standard transaction classifier. The receipt pipeline has its own approval gate (classify → approve → apply) and only writes to Actual Budget when the user explicitly clicks Apply.
3. **Single-item optimization**: Receipts with 1 line item just update the transaction category directly instead of the delete/reimport split flow
4. **Structured output**: LLM classification uses `generateObject()` with Zod schema, guaranteeing valid JSON responses with correct types
5. **Post-LLM tax inference**: Veryfi's per-item `type` field is unreliable (e.g., greeting cards typed as "food"). Instead, taxability is inferred from the LLM's category assignments using NM rules: categories matching `/^(groceries|medical|health|pharmacy|prescription)/i` are tax-exempt. Tax is reconciled again after the fallback pipeline, which may change categories.

---

## 5. File Inventory

### New Files (src/receipt/)

| File | Purpose |
|------|---------|
| `types.ts` | All TypeScript interfaces (ReceiptDocument, MatchConfidence, etc.) |
| `connector-registry.ts` | Map-based registry for OCR provider adapters |
| `veryfi-adapter.ts` | Veryfi OCR connector (browser auth, TOTP MFA) |
| `receipt-store.ts` | SQLite persistence (4 tables, 30+ methods) |
| `receipt-fetch-service.ts` | Orchestrates fetching from all connectors |
| `matching-service.ts` | Multi-signal scoring, conflict resolution, unmatch/rematch |
| `tax-allocator.ts` | Proportional tax distribution across line items |
| `line-item-classifier.ts` | LLM classification + 4-tier fallback pipeline |
| `split-transaction-service.ts` | Apply/rollback split transactions in Actual Budget |
| `batch-service.ts` | Batch operations (classify/approve/apply/unmatch/reject/reclassify) |
| `index.ts` | Barrel exports |

### New Files (src/web/views/)

| File | Purpose |
|------|---------|
| `receipt-renderer.ts` | Server-rendered HTML views for receipt workflow |

### New Files (src/templates/)

| File | Purpose |
|------|---------|
| `line-item-prompt.hbs` | Handlebars template for batch line-item classification |
| `line-item-fallback-prompt.hbs` | Template for single-item fallback classification (Tier 1) |

### Modified Files

| File | Changes |
|------|---------|
| `app.ts` | Receipt fetch/match on startup, batch callbacks, `createTempApiService` with `mkdirSync` fix |
| `src/container.ts` | DI wiring for all receipt services |
| `src/config.ts` | Receipt-related env vars and feature flags |
| `src/actual-api-service.ts` | `getTransactionById()`, `importTransactionsWithSplits()`, `deleteTransaction()` |
| `src/web/server.ts` | 4 page routes + 16 API endpoints for receipt workflow |
| `src/web/views/renderer.ts` | Receipt nav links in layout |
| `jest.config.js` | `testPathIgnorePatterns` to exclude `dist/` duplicates |

### Test Files

| File | Tests |
|------|-------|
| `tests/receipt-store.test.ts` | Receipt CRUD, matches, history, line items |
| `tests/matching-service.test.ts` | Scoring, conflict resolution, unmatch/rematch |
| `tests/tax-allocator.test.ts` | Proportional allocation, rounding, edge cases |
| `tests/split-plan-builder.test.ts` | Split plan construction, discrepancy handling |
| `tests/line-item-classifier.test.ts` | `cleanDescription`, `buildSearchQuery` helpers |
| `tests/batch-service.test.ts` | All batch operations, filter resolution, error collection |
| `tests/receipt-views.test.ts` | Store queue/detail methods, all 4 view renderers |
| + 15 pre-existing test files | Original transaction classifier tests |

**Total: 175 tests across 22 suites** (was previously double-counted as 302/41 due to `dist/` being picked up by jest)

---

## 6. API Endpoints

### Receipt Page Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/receipts` | Match queue with filtering, sorting, pagination, bulk actions |
| GET | `/receipts/:id` | Receipt detail with line items, split preview, actions |
| GET | `/receipts/unmatched` | Unmatched receipts list |
| GET | `/receipts/dashboard` | Summary stats and quick actions |

### Receipt API Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/receipts/unmatched` | List unmatched receipts (JSON) |
| GET | `/api/receipts/:id` | Get receipt by ID (JSON) |
| POST | `/api/receipts/fetch` | Trigger receipt fetch from all connectors |
| POST | `/api/receipts/:id/classify` | Classify line items for a receipt |
| POST | `/api/receipts/:id/apply` | Apply split/category to Actual Budget |
| GET | `/api/matches` | List matches with optional status filter |
| POST | `/api/matches/:id/unmatch` | Unmatch a receipt from its transaction |
| POST | `/api/matches/:id/rematch` | Rematch to a different transaction |
| PATCH | `/api/line-items/:id` | Update line item status (approve/reject) |
| POST | `/api/batch/classify` | Batch classify multiple matches |
| POST | `/api/batch/approve` | Batch approve line items |
| POST | `/api/batch/apply` | Batch apply splits |
| POST | `/api/batch/unmatch` | Batch unmatch |
| POST | `/api/batch/reject` | Batch reject |
| POST | `/api/batch/reclassify` | Batch re-classify |

---

## 7. Review UI Pages

### Receipt Match Queue (`/receipts`)

- Filterable by: status, confidence, override flag, vendor, date range, amount range
- Sortable columns: status, confidence, vendor, date, amount, matched time
- Checkbox selection with bulk actions: classify, approve, apply, reject, unmatch
- Row click navigates to detail page

### Receipt Detail (`/receipts/:id`)

Two-column layout:
- **Left**: Receipt metadata, line items table with per-item approve/reject buttons, raw OCR data
- **Right**: Transaction details, override warning banner, split preview with Apply button, actions (classify, re-classify, unmatch, rollback)
- Apply button shows "Apply Category" for single-item, "Apply Split" for multi-item
- Gentle pulse animation on Apply button after approving line items

### Unmatched Receipts (`/receipts/unmatched`)

Table of receipts with no transaction match.

### Dashboard (`/receipts/dashboard`)

Summary stat cards (total, matched, unmatched, by status) and quick actions.

---

## 8. Known Issues & Bugs

### FIXED: Tax reconciliation not updating after fallback pipeline (664e9b7)

**Severity**: Was causing incorrect tax allocation on reclassified items
**Root cause**: `updateLineItemClassification()` pushed raw JS booleans (`false`/`true`)
for the `taxable` column instead of converting to `0`/`1` for SQLite. The insert method
did the conversion correctly but the update method did not. This caused `reconcileTax()`
to silently fail to clear tax from items reclassified as tax-exempt (e.g., Groceries)
by the Tier 3 fallback pipeline.
**Fix**: Convert boolean → `0`/`1` in `updateLineItemClassification()`, matching the
pattern already used in `insertLineItemClassification()`. Added diagnostic logging
to `reconcileTax()` for future debugging.

### FIXED: NM tax rules not applied to line items (9be07b0, 11343de)

**Severity**: All items received proportional tax, including tax-exempt groceries
**Root cause**: Veryfi's per-item `type` field is unreliable at mixed-merchandise stores
(e.g., greeting cards typed as "food" at Albertsons). Initial approach of inferring
taxability from Veryfi data was abandoned.
**Fix**: Two-step approach — (1) LLM prompt includes NM tax context ("groceries and Rx
are tax-exempt") so it can make informed category decisions, (2) after LLM assigns
categories, taxability is inferred from category names using regex
`/^(groceries|medical|health|pharmacy|prescription)/i`. Tax is allocated only to
taxable items. If all items appear tax-exempt but receipt has tax, falls back to
proportional allocation (assumes misclassification).

### FIXED: Match status not promoted on individual line item approval (068f5f1)

**Severity**: Was blocking apply workflow
**Fix**: `PATCH /api/line-items/:id` now checks if all line items for the match are approved after each status update. If so, auto-promotes the match status to `'approved'`. Added `getLineItemClassification()` to receipt-store for retrieving the line item's `receiptMatchId`.

### FIXED: Price column showing $0.00 for most items (a6e5b32)

**Severity**: Cosmetic — line items showed `unitPrice` (Veryfi's `price`, zero 84% of the time)
**Fix**: Changed receipt detail view to display `totalPrice` (Veryfi's `total`) instead.

### FIXED: Container crash loop on startup (bf879db)

`createTempApiService()` passed `dataDir + 'apply/'` to the Actual Budget API without ensuring the directory existed. The API's internal `scandir` threw ENOENT, which surfaced as an uncaught promise rejection. Fixed by adding `mkdirSync` before `init()`.

### FIXED: Jest double-counting tests (906171a)

`npm run build` compiled test files into `dist/`, and jest picked them up as additional test files. Fixed by adding `testPathIgnorePatterns: ['/dist/']` to jest config. True count: 175 tests / 22 suites (was reported as 302/41).

### OPEN: LLM classification accuracy for ambiguous items

**Severity**: Low — items like "BLMNG UPGRADE 6"" (bakery bloom upgrade) get
classified as non-grocery by LLM, then Tier 3 fallback assigns majority category
(Groceries). The tax reconciliation now handles this correctly, but the initial
LLM classification could be improved with SERP context (Tier 1 fallback not
enabled — `webSearch` / `freeWebSearch` feature flags not set in production).

---

## 9. Status Flows

### Match Status

```
pending → classified → approved → applied
                   ↘ rejected
```

- `pending`: Match created, no classification yet
- `classified`: LLM has assigned categories to line items
- `approved`: All line items reviewed and approved (auto-promoted when last item approved individually)
- `applied`: Categories written to Actual Budget
- `rejected`: User rejected the match

### Line Item Status

```
(created during classification) → pending → approved
                                          → rejected
```

- `pending`: Category suggested, awaiting user review
- `approved`: User confirmed the suggested category
- `rejected`: User rejected the suggested category

### User Workflow

```
1. View queue (/receipts) → see matched receipts
2. Click a match → detail page (/receipts/:id)
3. Click "Classify" → LLM assigns categories
4. Review line items → approve/reject each (saves immediately)
5. Click "Apply Category" or "Apply Split" → writes to Actual Budget
```

---

## 10. dryRun Interaction

The `dryRun` feature flag affects the **standard transaction classifier** and **Actual Budget write operations**:

| Operation | dryRun behavior |
|-----------|----------------|
| Receipt fetch | Runs normally (writes to receipts.db only) |
| Receipt matching | Runs normally (writes to receipts.db only) |
| Line item classification | Runs normally (writes to receipts.db only) |
| Line item approve/reject | Saves immediately (receipts.db only) |
| Apply Category | **BLOCKED** — `updateTransactionNotesAndCategory` no-ops |
| Apply Split | **BLOCKED** — `deleteTransaction` and `importTransactionsWithSplits` no-op |
| Standard classification | **BLOCKED** — writes to classifications.db but no Actual Budget changes |

The receipt pipeline's own approval gate (classify → approve → apply) is independent
of dryRun. To actually write to Actual Budget, `dryRun` must be removed from FEATURES.

---

## 11. Environment Setup

### Required Environment Variables

```env
# Feature flags (add receiptMatching and lineItemClassification)
FEATURES=["classifyOnStartup", "syncAccountsBeforeClassify", "dryRun", "receiptMatching", "lineItemClassification"]

# Receipt connectors
RECEIPT_CONNECTORS=veryfi

# Veryfi credentials
VERYFI_USERNAME=<email>
VERYFI_PASSWORD=<password>
VERYFI_TOTP_SECRET=<totp-secret>
```

### Optional

```env
# Disable web search in fallback pipeline (default: enabled)
RECEIPT_FALLBACK_WEB_SEARCH=false

# Days to look back for receipts (default: 30)
RECEIPT_FETCH_DAYS_BACK=30
```

---

## 12. What Comes Next

### Remaining Plan Items

- [ ] **Phase 8**: Live testing — verify full workflow end-to-end with dryRun removed
- [ ] **Phase 9**: Production hardening — remove dryRun, monitor first real applies, verify rollback

### Deferred

- [ ] Unmatched transactions page (`/transactions/unmatched`) — requires persistent Actual Budget API connection
- [ ] `autoSplitTransactions` feature flag — auto-apply exact-match receipt splits without review
- [ ] Manual match UI — transaction picker modal for unmatched receipts
