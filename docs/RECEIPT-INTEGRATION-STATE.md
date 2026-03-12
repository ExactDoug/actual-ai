# Receipt Integration — Current State Document

**Date**: 2026-03-12 (updated: Phase 7 complete)
**Branch**: `feature/receipt-integration`
**Base**: `master`
**PR**: [#2](https://github.com/ExactDoug/actual-ai/pull/2) (open)
**Commits on branch**: 14+ (from `6010f7f` through latest)

---

## 1. Executive Summary

The receipt/OCR integration for actual-ai has been fully implemented across
Phases 1-7 of the plan, with line-item classification live-tested against
real receipt data. The implementation adds 12 new TypeScript files in
`src/receipt/` and `src/web/views/`, 2 Handlebars prompt templates, and modifies 9 existing files.
All 175 tests pass across 22 test suites. The full `npm run build` succeeds
with zero errors.

The system can now:
- Fetch receipts from Veryfi (or any future OCR provider) via a pluggable connector
- Match receipts to Actual Budget transactions using multi-signal scoring
- Classify individual line items on matched receipts via LLM with structured
  output (JSON schema enforcement via `generateObject()` + Zod)
- Distribute tax proportionally across line items
- Convert single transactions into split transactions with per-item categories
- Roll back splits to restore the original transaction
- Expose 16 new REST API endpoints for the Review UI to consume

The integration is gated behind the `receiptMatching` feature flag and is
completely dormant unless explicitly enabled.

---

## 2. Branch & Commit History

```
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

## 3. New Files Created

### 3.1 `src/receipt/types.ts`
All TypeScript interfaces for the receipt integration module.

**Interfaces defined:**
- `ReceiptLineItem` — normalized line item with description, quantity, unitPrice (cents), totalPrice (cents), optional category and taxable flag
- `ReceiptDocument` — normalized receipt with externalId, providerId, vendorName, vendorId, date (YYYY-MM-DD), currency, all amounts in cents (totalAmount, subtotalAmount, taxAmount, tipAmount, discountAmount, shippingAmount), lineItems array, rawData (full provider response), optional imageUrl
- `MatchConfidence` — union type: `'exact' | 'probable' | 'possible' | 'manual'`
- `MatchStatus` — union type: `'pending' | 'classified' | 'approved' | 'applied' | 'rejected'`
- `ReceiptMatch` — match record with id, transactionId, receiptId, matchConfidence, matchedAt, status, optional preSplitSnapshot
- `ReceiptMatchHistory` — audit trail entry with id, receiptId, old/new transactionId, action (match/unmatch/rematch), old/new matchConfidence, reason, performedAt, performedBy
- `LineItemClassificationStatus` — union type: `'pending' | 'approved' | 'rejected'`
- `LineItemClassification` — per-item classification result with all amounts, suggested category, classification type, confidence, status
- `SplitEntry` — single subtransaction: amount (cents, negative for expenses), categoryId, notes
- `SplitPlan` — transactionId + array of SplitEntry
- `ReceiptConnector` — interface that all OCR provider adapters must implement: `providerId`, `fetchReceipts(since)`, `testConnection()`

### 3.2 `src/receipt/connector-registry.ts`
Simple Map-based registry mapping `providerId` → `ReceiptConnector` instance.

**Class**: `ConnectorRegistry` (default export)
**Methods**: `register(connector)`, `get(providerId)`, `getAll()`, `has(providerId)`

### 3.3 `src/receipt/veryfi-adapter.ts`
Adapter implementing `ReceiptConnector` that wraps the existing Veryfi client.

**Class**: `VeryfiAdapter` (default export)
**Constructor**: `(username, password, totpSecret)`
**Provider ID**: `'veryfi'`

**Key behaviors:**
- Lazy authentication: calls `authenticate()` from `../veryfi/auth` on first use
- Creates `VeryfiClient` with credentials, configures `setAuthCredentials()` for auto-reauth on 401
- `fetchReceipts(since)`: fetches from Veryfi API, maps each VeryfiReceipt → ReceiptDocument
- Each receipt mapping wrapped in try/catch (one bad receipt doesn't stop the batch)
- Returns `{ receipts, errors }`

**Critical field mappings (Veryfi → ReceiptDocument):**
- `date` ← `receipt.stamp_date` (OCR date), NOT `receipt.date` or `receipt.created`
- `stamp_date` fallback: `receipt.created.split('T')[0]`, then today's date
- All amounts: `Math.round(dollarValue * 100)` converting float dollars to integer cents
- `vendorName` ← `receipt.business_name ?? ''`
- `vendorId` ← `String(receipt.business_id)` when non-null
- `externalId` ← `String(receipt.id)` (Veryfi uses numeric IDs)
- `currency` ← `receipt.currency_code ?? 'USD'`
- `imageUrl` ← `receipt.img ?? receipt.pdf`
- Line items: `totalPrice` ← `Math.round(item.total * 100)` — uses `.total` NOT `.price` (84% of `.price` values are zero in Veryfi data)
- Line item `taxable` always set to `null` (Veryfi line-item tax is always 0)

**`testConnection()`**: authenticates then delegates to `client.testConnection()`, catches errors and returns `{ ok: false, message }` on failure

### 3.4 `src/receipt/receipt-store.ts`
SQLite persistence layer for all receipt integration data. Uses `better-sqlite3` with WAL mode and foreign keys enabled.

**Class**: `ReceiptStore` (default export)
**Constructor**: `(dataDir: string)` — creates `${dataDir}/receipts.db`, ensures directory exists
**DB location**: `/tmp/actual-ai/receipts.db` (separate from `classifications.db`)

**Tables created by `migrate()`:**

1. **`receipts`**
   - `id TEXT PRIMARY KEY` (UUID)
   - `externalId TEXT NOT NULL`
   - `providerId TEXT NOT NULL`
   - `vendorName TEXT`
   - `vendorId TEXT`
   - `totalAmount INTEGER NOT NULL` (cents)
   - `date TEXT NOT NULL` (YYYY-MM-DD)
   - `currency TEXT DEFAULT 'USD'`
   - `lineItemCount INTEGER DEFAULT 0`
   - `taxAmount INTEGER DEFAULT 0` (cents)
   - `receiptData TEXT NOT NULL` (full ReceiptDocument JSON)
   - `fetchedAt TEXT NOT NULL` (ISO 8601)
   - `UNIQUE(providerId, externalId)`

2. **`receipt_matches`**
   - `id TEXT PRIMARY KEY` (UUID)
   - `transactionId TEXT NOT NULL`
   - `receiptId TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE`
   - `matchConfidence TEXT NOT NULL` (exact/probable/possible/manual)
   - `matchedAt TEXT NOT NULL`
   - `status TEXT DEFAULT 'pending'` (pending/classified/approved/applied/rejected)
   - `preSplitSnapshot TEXT` (original transaction JSON for rollback)
   - `UNIQUE(transactionId, receiptId)`

3. **`receipt_match_history`**
   - `id TEXT PRIMARY KEY` (UUID)
   - `receiptId TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE`
   - `oldTransactionId TEXT`
   - `newTransactionId TEXT`
   - `action TEXT NOT NULL` (match/unmatch/rematch)
   - `oldMatchConfidence TEXT`
   - `newMatchConfidence TEXT`
   - `reason TEXT`
   - `performedAt TEXT NOT NULL`
   - `performedBy TEXT DEFAULT 'system'`

4. **`line_item_classifications`**
   - `id TEXT PRIMARY KEY` (UUID)
   - `receiptMatchId TEXT NOT NULL REFERENCES receipt_matches(id) ON DELETE CASCADE`
   - `lineItemIndex INTEGER NOT NULL`
   - `description TEXT NOT NULL`
   - `quantity REAL DEFAULT 1`
   - `unitPrice INTEGER NOT NULL` (cents)
   - `totalPrice INTEGER NOT NULL` (cents)
   - `taxable INTEGER` (1, 0, or NULL)
   - `allocatedTax INTEGER DEFAULT 0` (cents)
   - `amountWithTax INTEGER NOT NULL` (cents)
   - `suggestedCategoryId TEXT`
   - `suggestedCategoryName TEXT`
   - `classificationType TEXT` (existing/new/rule/fallback)
   - `confidence TEXT` (high/medium/low)
   - `status TEXT DEFAULT 'pending'` (pending/approved/rejected)
   - `notes TEXT`
   - `UNIQUE(receiptMatchId, lineItemIndex)`

**View**: `transaction_receipt_status` — joins receipt_matches with receipts, includes approved/total item counts

**Indexes**: on `receipts(providerId, externalId)`, `receipt_matches(status)`, `receipt_matches(transactionId)`, `receipt_matches(receiptId)`

**Methods (receipt operations):**
- `upsertReceipt(record)` — INSERT OR REPLACE keyed on (providerId, externalId), preserves existing UUID on update via pre-SELECT
- `getReceipt(id)` — by primary key
- `getReceiptByExternalId(providerId, externalId)`
- `listReceipts(filter: { status?, page?, limit? })` — paginated with LEFT JOIN to receipt_matches for status
- `findNearDuplicates(vendorName, date, totalAmount, toleranceCents)` — same vendor, same date, amount within tolerance

**Methods (match operations):**
- `createMatch(transactionId, receiptId, confidence)` — generates UUID, sets status='pending', matchedAt=now
- `updateMatchStatus(matchId, status)`
- `getMatch(matchId)`
- `getMatchForReceipt(receiptId)` — single match or undefined
- `getMatchForTransaction(transactionId)` — single match or undefined
- `getUnmatchedReceipts()` — LEFT JOIN where match is NULL
- `getMatchesByStatus(status)`
- `setPreSplitSnapshot(matchId, snapshot)`
- `deleteMatch(matchId)`

**Methods (history):**
- `insertMatchHistory(entry)` — generates UUID, sets performedAt=now
- `getMatchHistory(receiptId)` — ordered by performedAt DESC

**Methods (line item classifications):**
- `insertLineItemClassification(record)` — generates UUID
- `getClassificationsForMatch(matchId)` — ordered by lineItemIndex
- `updateLineItemStatus(id, status)`
- `deleteClassificationsForMatch(matchId)`

**Methods (stats):**
- `getStats()` — returns `{ totalReceipts, totalMatched, pending, classified, approved, applied, rejected, totalUnmatched }`

**Utility:** `close()` — closes the database connection

### 3.5 `src/receipt/receipt-fetch-service.ts`
Orchestrates fetching receipts from all registered connectors and upserting them into the store.

**Class**: `ReceiptFetchService` (default export)
**Constructor**: `(registry: ConnectorRegistry, store: ReceiptStore, fetchDaysBack: number)`

**`fetchAll()`:**
- Calculates `since = now - fetchDaysBack * 86400000 ms`
- Iterates all connectors in registry
- Each connector call wrapped in top-level try/catch (one failing connector doesn't abort others)
- For each receipt: checks for near-duplicates (logs warning but still inserts), upserts into store
- Maps ReceiptDocument fields to store record format (including `receiptData: JSON.stringify(receipt)`)
- Returns `{ fetched: number, errors: Array<{ provider, message }> }`
- Logs one-line summary

### 3.6 `src/receipt/matching-service.ts`
Transaction-to-receipt matching with multi-signal scoring, conflict resolution, and unmatch/rematch support.

**Class**: `MatchingService` (default export)
**Constructor**: `(store: ReceiptStore, toleranceCents: number, toleranceDays: number, autoMatch: boolean)`

**`matchAll(transactions)`:**

Algorithm:
1. Gets unmatched receipts from store
2. Filters out transactions that already have a match, and zero-amount items on both sides
3. For each receipt, scores against every available transaction:
   - **Amount signal**: `Math.abs(receipt.totalAmount - Math.abs(tx.amount))` ≤ toleranceCents
   - **Date signal**: `daysBetween(receipt.date, tx.date)` ≤ toleranceDays
   - **Vendor signal**: case-insensitive substring match after stripping business suffixes (Inc, LLC, Corp, Corporation, Incorporated, Ltd, Limited, Co, Company)
4. Confidence assignment:
   - `exact`: all three signals match
   - `probable`: amount + (date OR vendor)
   - `possible`: amount only
   - No amount match → no candidate
5. Per receipt: picks best candidate (highest confidence, tiebreak by closest amount)
6. Conflict resolution: if multiple receipts claim same transaction, best-scoring receipt wins
7. Creates matches and records history entries
8. Returns `{ matched, exact, probable, possible, unmatched }`

**Helper functions:**
- `daysBetween(dateA, dateB)` — parses YYYY-MM-DD, returns absolute day difference
- `normalizeVendor(name)` — strips business suffixes, lowercases, trims
- `vendorMatch(vendorName, payee, importedPayee)` — bidirectional substring check after normalization

**`unmatch(matchId)`:**
- Validates match exists, throws if status is 'applied' (must rollback split first)
- Deletes classifications for the match
- Deletes the match record
- Records history entry with action='unmatch'

**`rematch(matchId, newTransactionId)`:**
- Validates match exists, throws if status is 'applied'
- Records history with action='rematch', captures old and new transaction IDs
- Deletes old classifications and match
- Creates new match with confidence='manual'
- Returns new match ID

### 3.7 `src/receipt/tax-allocator.ts`
Pure function module for distributing receipt-level tax across line items.

**`allocateTax(input)` (default export):**

Input: `{ lineItems: Array<{ totalPrice, taxable }>, totalTax }`
Output: `{ allocations: Array<{ allocatedTax, amountWithTax }>, adjustment }`

Algorithm:
1. If totalTax === 0: all items get 0 tax, amountWithTax = totalPrice
2. If any items have explicit taxable flag (not null):
   - Calculate taxableTotal from items where taxable === true
   - If taxableTotal !== 0: allocate proportionally among taxable items
   - Non-taxable items get 0 tax
   - If taxableTotal === 0: fall through to step 3
3. Proportional allocation across ALL items by totalPrice
   - If allItemsTotal === 0: all items get 0
4. Rounding adjustment: `remainder = totalTax - sum(allocatedTax)`
   - If remainder !== 0: add to item with largest Math.abs(totalPrice)
5. Build result: amountWithTax = totalPrice + allocatedTax

**`validateReceiptBalance(lineItemAmounts, additionalCharges, expectedTotal)` (named export):**
- Pure validation — returns `{ balanced: boolean, discrepancy: number }`
- Does not modify anything

**Internal helpers:**
- `proportionalAllocate(lineItems, totalTax)` — distributes tax by price ratio
- `indexOfLargestAbs(lineItems)` — finds item with largest absolute totalPrice

### 3.8 `src/receipt/line-item-classifier.ts`
LLM-based classification of individual receipt line items using structured
output (JSON schema enforcement).

**Class**: `LineItemClassifier` (default export)
**Constructor**: `(llmService: LlmService, promptGenerator: PromptGenerator, store: ReceiptStore, receiptTag: string)`
- Reads and compiles `src/templates/line-item-prompt.hbs` at construction time
- Defines Zod schema for structured output:
  ```typescript
  z.object({
    items: z.array(z.object({
      itemIndex: z.number(),
      type: z.string(),
      categoryId: z.string(),
      confidence: z.enum(['high', 'medium', 'low']),
    })),
  })
  ```

**`classifyReceipt(matchId, categories, categoryGroups)`:**

Steps:
1. Gets match from store; returns early if status !== 'pending'
2. Parses stored receiptData JSON back to ReceiptDocument
3. Returns early if 0 line items (leaves status as pending)
4. Builds prompt context: vendorName, date, line items with formatted dollar amounts, additional charges (tip/shipping if non-zero), category groups
5. Renders Handlebars template
6. Calls `llmService.generateStructuredOutput(prompt, schema)` — uses
   `generateObject()` from Vercel AI SDK which sends `response_format`
   with JSON schema to the API, guaranteeing valid structured output
7. Runs `allocateTax()` on receipt line items
8. Validates receipt balance; adjusts largest item if unbalanced
9. Inserts line_item_classifications for each item:
    - Maps LLM results by itemIndex
    - Items with no LLM result or low confidence → classificationType='fallback'
    - Finds category name from categories array
10. Updates match status to 'classified'
11. Logs summary with confidence breakdown

**`formatCents(cents)`:** converts 250 → "$2.50", -100 → "-$1.00"

### 3.9 `src/receipt/split-plan-builder.ts`
Converts classified line items into an Actual Budget split plan.

**`buildSplitPlan(transactionId, classifications, additionalCharges, originalTransactionAmount)` (default export):**

1. Filters to approved classifications with non-null suggestedCategoryId
2. Builds SplitEntry per item: amount = -amountWithTax (negated for expenses), categoryId, notes = description
3. Adds entries for additional charges (tip/shipping/fee); uses most-common category as fallback if charge has no categoryId
4. Compares split sum to originalTransactionAmount
5. Adjusts largest-absolute-amount split for rounding difference
6. Returns `{ transactionId, splits }`

**Internal helpers:**
- `getMostCommonCategory(splits)` — frequency count of categoryIds
- `indexOfLargestAbsAmount(splits)` — finds split with largest Math.abs(amount)

### 3.10 `src/receipt/split-transaction-service.ts`
Handles the delete-and-recreate pattern for converting transactions into splits, with snapshot-based rollback.

**Class**: `SplitTransactionService` (default export)
**Constructor**: `(actualApiService: ActualApiService, store: ReceiptStore, receiptTag: string)`

**`applySplit(matchId)`:**
1. Validates match status is 'approved'
2. Gets receipt from store
3. Gets original transaction from Actual Budget via `getTransactionById()`
4. Safeguards: throws if is_parent (already split) or reconciled
5. Snapshots transaction to `preSplitSnapshot`
6. Gets approved classifications from store
7. Extracts additional charges (tip, shipping) from receipt JSON
8. Builds split plan
9. Deletes original transaction
10. Re-creates via `importTransactionsWithSplits()` with subtransactions, appending receiptTag to notes
11. Updates match status to 'applied'

**`rollbackSplit(matchId)`:**
1. Validates match status is 'applied'
2. Gets pre-split snapshot (throws if none)
3. Parses snapshot JSON
4. Deletes current split transaction
5. Re-creates original from snapshot (no subtransactions), removing receiptTag from notes
6. Updates match status back to 'approved'

**Helpers:**
- `appendTag(notes, tag)` — idempotent tag append
- `removeTag(notes, tag)` — removes tag with whitespace cleanup
- `extractAdditionalCharges(receipt)` — parses receiptData JSON, extracts tip/shipping as charges
- `asNumberOrZero(value)` — safe coercion to non-negative integer

### 3.11 `src/receipt/index.ts`
Barrel exports for the entire receipt module:
- ReceiptStore, ConnectorRegistry, VeryfiAdapter, ReceiptFetchService
- MatchingService, LineItemClassifier, SplitTransactionService
- allocateTax, validateReceiptBalance, buildSplitPlan
- All types from `./types`

### 3.12 `src/templates/line-item-prompt.hbs`
Handlebars template for line-item LLM classification. Used with structured
output (`generateObject()` + Zod schema) — the response format is enforced
by the JSON schema, not by prompt instructions. The prompt provides context:
- Vendor name, date, account context
- Numbered line items with description, quantity, unit price, total price
- Optional additional charges section
- Full category group listing with IDs
- Example response in `{ items: [...] }` wrapper format
- Classification instructions for high/medium/low confidence

### 3.13 `src/templates/line-item-fallback-prompt.hbs`
Handlebars template for single-item fallback classification (Tier 1). Includes:
- Vendor name, date, specific item to classify
- Web search results (when available)
- Other items on the same receipt with their classifications (context)
- Full category group listing with IDs
- Uses same structured output schema as batch classification

---

## 4. Modified Files

### 4.1 `src/config.ts`

**New env var exports:**
- `receiptConnectors` — parsed from `RECEIPT_CONNECTORS` (comma-separated string → string array)
- `veryfiUsername` — from `VERYFI_USERNAME`
- `veryfiPassword` — from `VERYFI_PASSWORD`
- `veryfiTotpSecret` — from `VERYFI_TOTP_SECRET`
- `receiptMatchToleranceCents` — from `RECEIPT_MATCH_TOLERANCE_CENTS`, default 5
- `receiptDateToleranceDays` — from `RECEIPT_DATE_TOLERANCE_DAYS`, default 1
- `receiptAutoMatch` — from `RECEIPT_AUTO_MATCH`, default true (string !== 'false')
- `receiptFetchDaysBack` — from `RECEIPT_FETCH_DAYS_BACK`, default 30
- `receiptTag` — from `RECEIPT_TAG`, default '#actual-ai-receipt'
- `receiptFallbackWebSearch` — from `RECEIPT_FALLBACK_WEB_SEARCH`, default true

**New feature flags (registered in `registerReceiptFeatures()`):**
- `receiptMatching` — enables the receipt matching pipeline
- `lineItemClassification` — enables per-line-item classification (requires receiptMatching)
- `autoSplitTransactions` — auto-apply exact-match receipt splits without review

**New function: `validateFeatureDependencies()`:**
- If `lineItemClassification` enabled but `receiptMatching` not → disables lineItemClassification + logs warning
- If `autoSplitTransactions` enabled but either dependency missing → disables autoSplitTransactions + logs warning
- Called at startup after all feature registration

### 4.2 `src/container.ts`

**New imports:**
- ReceiptStore, ConnectorRegistry, VeryfiAdapter, ReceiptFetchService, MatchingService, LineItemClassifier, SplitTransactionService
- New config exports: receiptAutoMatch, receiptConnectors, receiptDateToleranceDays, receiptFetchDaysBack, receiptMatchToleranceCents, receiptTag, veryfiUsername, veryfiPassword, veryfiTotpSecret

**New instantiations:**
- `receiptStore` — `new ReceiptStore(dataDir)`
- `connectorRegistry` — `new ConnectorRegistry()`
- VeryfiAdapter registered if `receiptConnectors.includes('veryfi')` AND credentials present
- `receiptFetchService` — `new ReceiptFetchService(connectorRegistry, receiptStore, receiptFetchDaysBack)`
- `matchingService` — `new MatchingService(receiptStore, toleranceCents, toleranceDays, autoMatch)`
- `lineItemClassifier` — `new LineItemClassifier(llmService, promptGenerator, receiptStore, receiptTag)`
- `splitTransactionService` — `new SplitTransactionService(actualApiService, receiptStore, receiptTag)`

**New exports:** `receiptStore`, `connectorRegistry`, `receiptFetchService`, `matchingService`, `lineItemClassifier`, `splitTransactionService`

### 4.3 `app.ts`

**New imports from container:** `receiptFetchService`, `receiptStore`, `connectorRegistry`, `matchingService`, `lineItemClassifier`, `splitTransactionService`

**Modified `runClassification()`:**
When `receiptMatching` feature flag is enabled, before running AI classification:
1. Calls `receiptFetchService.fetchAll()` to fetch latest receipts (errors logged, not thrown)
2. Creates a temporary Actual Budget API connection
3. Fetches all transactions, filters to uncategorized non-parent non-zero ones
4. Calls `matchingService.matchAll()` with the filtered transactions
5. Both steps wrapped in try/catch — failures don't block regular classification

**Modified web server deps:**
When `receiptMatching` is enabled, passes to `createWebServer()`:
- `receiptStore`
- `connectorRegistry`
- `onReceiptFetch` — delegates to `receiptFetchService.fetchAll()`
- `onReceiptClassify` — creates temp API connection, fetches categories/groups, calls `lineItemClassifier.classifyReceipt()`
- `onReceiptApplySplit` — delegates to `splitTransactionService.applySplit()`
- `onReceiptUnmatch` — delegates to `matchingService.unmatch()`
- `onReceiptRematch` — delegates to `matchingService.rematch()`
- `onReceiptRollback` — delegates to `splitTransactionService.rollbackSplit()`

### 4.4 `src/actual-api-service.ts`

**Three new public methods:**

1. `getTransactionById(id: string): Promise<TransactionEntity | undefined>`
   - Calls `getTransactions()` (fetches all from all accounts), returns `find(t => t.id === id)`
   - Note: no native get-by-id on the Actual Budget API

2. `deleteTransaction(id: string): Promise<void>`
   - Calls `this.actualApiClient.deleteTransaction(id)`
   - Verified that `deleteTransaction` exists on `@actual-app/api` (line 59 of methods.d.ts)
   - Respects isDryRun

3. `importTransactionsWithSplits(accountId, transactions): Promise<void>`
   - Maps input to `ImportTransactionEntity` objects (adds `account` field)
   - Calls `this.actualApiClient.importTransactions(accountId, ...)`
   - The `subtransactions` field is supported by the ImportTransactionEntity type
   - Respects isDryRun

### 4.5 `src/types.ts`

Updated `ActualApiServiceI` interface with the three new method signatures to match the implementation.

### 4.6 `src/web/server.ts`

**Updated `WebServerDeps` interface** with optional properties:
- `receiptStore?: ReceiptStore`
- `connectorRegistry?: ConnectorRegistry`
- `onReceiptFetch?`, `onReceiptClassify?`, `onReceiptApplySplit?`, `onReceiptUnmatch?`, `onReceiptRematch?`, `onReceiptRollback?` (all callback functions)

**New API endpoints** (all behind `authMiddleware`, wrapped in `if (deps.receiptStore)` conditional):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/receipts` | List receipts with pagination and status filter |
| GET | `/api/receipts/unmatched` | Unmatched receipts (no match row) |
| GET | `/api/receipts/:id` | Single receipt by ID (404 if not found) |
| GET | `/api/transactions/unmatched` | Returns 501 Not Implemented (needs Actual Budget data) |
| GET | `/api/connectors` | List registered connectors |
| POST | `/api/connectors/:id/test` | Test connector connectivity |
| GET | `/api/receipt-stats` | Receipt store statistics |
| POST | `/api/receipts/fetch` | Trigger receipt fetch from all connectors |
| POST | `/api/receipts/:id/match` | Manual match receipt to transaction (body: `{ transactionId }`) |
| GET | `/api/receipts/:id/splits` | Preview proposed split (match + classifications) |
| POST | `/api/receipts/:id/classify` | Trigger LLM line-item classification |
| POST | `/api/receipts/:id/apply` | Apply split to Actual Budget |
| POST | `/api/matches/:id/unmatch` | Remove match (rollback if applied) |
| POST | `/api/matches/:id/rematch` | Rematch to different transaction (body: `{ transactionId }`) |
| GET | `/api/matches/:id/history` | Match audit trail |
| PATCH | `/api/line-items/:id` | Update line item status (approved/rejected) |

**New helper:** `parseReceiptFilter(query)` — extracts status, page, limit from query params

### 4.7 `tests/test-doubles/in-memory-actual-api-service.ts`

Added stub implementations for the three new ActualApiService methods to keep test compilation working.

---

## 5. Feature Flag Configuration

To enable the full receipt integration, add to the `FEATURES` env var:

```json
["classifyOnStartup", "syncAccountsBeforeClassify", "receiptMatching", "lineItemClassification"]
```

Required env vars when `receiptMatching` is enabled:
```
RECEIPT_CONNECTORS=veryfi
VERYFI_USERNAME=<email>
VERYFI_PASSWORD=<password>
VERYFI_TOTP_SECRET=<base32 secret>
```

Optional tuning:
```
RECEIPT_MATCH_TOLERANCE_CENTS=5
RECEIPT_DATE_TOLERANCE_DAYS=1
RECEIPT_AUTO_MATCH=true
RECEIPT_FETCH_DAYS_BACK=30
RECEIPT_TAG=#actual-ai-receipt
```

---

## 6. Data Flow — Complete Pipeline

```
Cron job or manual trigger
  │
  ├─ [if receiptMatching enabled]
  │   │
  │   ├─ 1. Receipt Fetch
  │   │   └─ ConnectorRegistry → VeryfiAdapter.fetchReceipts()
  │   │       └─ authenticate (5-step MFA with TOTP anti-replay)
  │   │       └─ fetch receipts since (now - RECEIPT_FETCH_DAYS_BACK)
  │   │       └─ map VeryfiReceipt → ReceiptDocument (stamp_date, dollars→cents)
  │   │       └─ near-duplicate detection (warn but still insert)
  │   │       └─ upsert into SQLite receipts table
  │   │
  │   ├─ 2. Transaction Matching
  │   │   └─ MatchingService.matchAll(uncategorized transactions)
  │   │       └─ score each receipt against each transaction
  │   │       └─ signals: amount (High), date (Medium), vendor (Low-Med)
  │   │       └─ confidence: exact (all 3), probable (amount + 1), possible (amount only)
  │   │       └─ conflict resolution: best score wins per transaction
  │   │       └─ persist matches + audit history
  │   │
  │   └─ (future: auto-classify exact matches when lineItemClassification enabled)
  │
  └─ 3. Regular Classification (existing pipeline, unchanged)
      └─ ActualAiService.classify()

Review UI (manual operations via API endpoints)
  │
  ├─ View receipts, matches, unmatched items
  ├─ Manual match: POST /api/receipts/:id/match
  ├─ Classify: POST /api/receipts/:id/classify
  │   └─ LineItemClassifier.classifyReceipt()
  │       └─ build Handlebars prompt with all line items
  │       └─ LLM call → JSON array of per-item classifications
  │       └─ allocateTax() → distribute receipt tax proportionally
  │       └─ validateReceiptBalance() → adjust if discrepancy
  │       └─ store classifications → update match status to 'classified'
  │
  ├─ Approve line items: PATCH /api/line-items/:id { status: 'approved' }
  │   (user approves each line item's suggested category)
  │   Then: update match status to 'approved' (manual via API)
  │
  ├─ Apply split: POST /api/receipts/:id/apply
  │   └─ SplitTransactionService.applySplit()
  │       └─ snapshot original transaction
  │       └─ build split plan (negate amounts, rounding adjustment)
  │       └─ delete original transaction
  │       └─ re-create with subtransactions via importTransactions()
  │       └─ append #actual-ai-receipt tag
  │       └─ update match status to 'applied'
  │
  ├─ Unmatch: POST /api/matches/:id/unmatch
  │   └─ if applied: rollbackSplit() first (restore original, remove tag)
  │   └─ delete classifications and match, record history
  │
  └─ Rematch: POST /api/matches/:id/rematch { transactionId }
      └─ record history (old + new), delete old, create new with confidence='manual'
```

---

## 7. State Machine — Receipt Match Lifecycle

```
              ┌──────────┐
              │ (no match)│  receipt & transaction in unmatched pools
              └─────┬─────┘
                    │ match (auto or manual)
                    ▼
              ┌──────────┐
              │ pending   │  matched, awaiting classification
              └─────┬─────┘
                    │ POST /api/receipts/:id/classify
                    ▼
              ┌──────────┐
              │classified │  line items classified, split plan ready
              └─────┬─────┘
                    │ user approves all line items
                    ▼
              ┌──────────┐
              │ approved  │  user approved, ready to apply
              └─────┬─────┘
                    │ POST /api/receipts/:id/apply
                    ▼
              ┌──────────┐
              │ applied   │  split written to Actual Budget
              └──────────┘

Any state → rejected (user rejects)
Any state → (no match) (unmatch; rollback if applied)
```

---

## 8. Known Limitations & Open Items

### 8.1 Not Yet Verified (Needs Live Testing)

- **Transaction ID preservation**: When deleting and re-creating a transaction via `importTransactions()`, the Actual Budget API may or may not preserve the original ID. This needs to be tested with a real Actual Budget instance. If IDs change, all references in `receipt_matches` and `line_item_classifications` need to be updated. The `preSplitSnapshot` stores the original transaction for rollback regardless.

### 8.1b Verified via Live Testing (2026-03-12) — LLM Classification

- **LLM line-item classification**: Tested against GPT-4.1 via Azure OpenAI with real receipt data. Three receipts classified successfully:
  - Albertsons (7 items): 5 high, 2 low confidence — groceries correct, ambiguous items got reasonable fallback guesses
  - Dollar Tree (15 items): 15/15 high confidence — craft supplies → Hobbies
  - Safeway (4 items): 4/4 high confidence — groceries correct
- **Structured output**: Migrated from raw text + JSON parsing to `generateObject()` with Zod schema. Eliminates JSON parse failures from LLM comments/formatting.
- **Bugs fixed during live testing**:
  - `askUsingFallbackModel()` stripped all quotes from responses (destroyed JSON). Added `generateRawText()`, then replaced with `generateStructuredOutput()`.
  - GPT-4.1 adds `//` comments and trailing commas to JSON. Added cleanup to `cleanJsonResponse()` for other callers; structured output doesn't need it.

### 8.2 Verified via Live Testing (2026-03-12)

- **Veryfi adapter end-to-end**: 31 receipts fetched successfully from the live Veryfi API. TOTP auth with anti-replay works correctly. Near-duplicate detection logs warnings on subsequent runs.
- **Matching against real Actual Budget**: Connected to `https://budget.dandelionfieldsnm.com`, matched 21 receipts to transactions. Identified and fixed three bugs (date format, vendor normalization, payee resolution). 2 probable matches confirmed correct (Arby's, Dick's Sporting Goods).
- **Retroactive matching**: Matching pool widened to include already-categorized transactions. `overridesExisting` flag correctly set on matches to previously-categorized transactions.

### 8.3 Not Yet Implemented

- ~~**Review UI HTML views**: Now complete. See Phase 7 deliverables.~~

- **`GET /api/transactions/unmatched`**: Returns 501 Not Implemented. Requires a running Actual Budget API connection to fetch transaction data, which is not available to the web server in the current architecture (the API connection is transient, used only during classification runs).

- **`autoSplitTransactions` feature flag**: The flag is registered but not wired into any automatic behavior. It was designed for future use where exact matches could bypass the review step entirely.

### 8.3 Data Quality Caveats (from Veryfi Corpus Analysis)

- **46% of receipts** have `total ≠ subtotal + tax + tip - discount + shipping`. The tax allocator handles this via the balance validation + adjustment to largest item, but large adjustments should be investigated by the user.

- **84% of line item `price` values are zero** in Veryfi data. The adapter correctly uses `item.total` instead. If a future provider populates `price` correctly, the adapter mapping would need to be reviewed.

- **Line-item tax is always 0** in Veryfi. Tax exists only at the receipt level. The `taxable` field on line items is always set to `null` by the Veryfi adapter. If Veryfi adds line-item tax in the future, the adapter would need updating.

- **`business_id`** is the reliable vendor dedup key (199 unique values across 455 receipts), not `business_name` (which has inconsistent formatting). The adapter stores `vendorId = String(business_id)` for this purpose, but the matching service currently uses `vendorName` for fuzzy matching against transaction payees (since transaction payees don't have Veryfi business IDs).

- **`stamp_date`** can be null or incorrectly OCR'd. The adapter falls back to `created` timestamp, then today's date. Users should verify receipt dates match transaction dates for probable/possible matches.

### 8.4 Architectural Notes

- **Separate SQLite databases**: Receipt data lives in `receipts.db`, classification data in `classifications.db`. They are independent — no cross-database queries. This means the existing classification pipeline is completely unaffected by the receipt integration.

- **Data dir locking**: The existing `acquireDataDirLock()` mechanism in `ActualApiService` prevents concurrent classification runs. Receipt fetch and matching happen within the same `runClassification()` call, so they're protected by the same lock. The Review UI endpoints do NOT acquire the lock — they read/write SQLite directly, which is safe due to WAL mode.

- **Transient API connections**: The web server creates temporary Actual Budget API connections (`createTempApiService()`) when it needs to talk to Actual Budget (e.g., for applying classifications, fetching categories). These connections are short-lived and cleaned up in `finally` blocks.

- **DI via container.ts**: All receipt services are instantiated in `container.ts` and exported. The `app.ts` wires them into the cron pipeline and web server via callbacks. No global state beyond what's in the container.

---

## 9. File Inventory Summary

### New Files (14)
```
src/receipt/types.ts                  — TypeScript interfaces
src/receipt/connector-registry.ts     — Provider registry
src/receipt/veryfi-adapter.ts         — Veryfi ReceiptConnector implementation
src/receipt/receipt-store.ts          — SQLite persistence (4 tables, 1 view)
src/receipt/receipt-fetch-service.ts  — Fetch-and-store orchestrator
src/receipt/matching-service.ts       — Multi-signal matching algorithm
src/receipt/tax-allocator.ts          — Tax distribution with rounding
src/receipt/line-item-classifier.ts   — LLM classification + tax allocation + fallback pipeline
src/receipt/split-plan-builder.ts     — Classifications → split plan
src/receipt/split-transaction-service.ts — Delete+re-create with rollback
src/receipt/batch-service.ts           — Batch operations orchestrator (6 operations)
src/receipt/index.ts                  — Barrel exports
src/templates/line-item-prompt.hbs    — Handlebars template for batch LLM classification
src/templates/line-item-fallback-prompt.hbs — Handlebars template for single-item fallback
```

### Modified Files (9)
```
src/config.ts                         — 10 new env vars, 3 feature flags, dependency validation
src/container.ts                      — 7 new service instantiations, 6 new exports
app.ts                                — Receipt fetch+match in pipeline, web server callbacks
src/actual-api-service.ts             — 3 new methods (getById, delete, importWithSplits)
src/types.ts                          — Interface updates for new API methods
src/llm-service.ts                    — generateStructuredOutput() with Zod schema
src/utils/json-utils.ts               — cleanJsonResponse: comment stripping, trailing comma removal
src/web/server.ts                     — 16 new API endpoints, 6 new callback deps
tests/test-doubles/in-memory-actual-api-service.ts — Stub methods for test compilation
```

### Docs
```
docs/RECEIPT-INTEGRATION-REQUIREMENTS.md  — Full spec with fallback pipeline (Section 5.5)
docs/RECEIPT-INTEGRATION-PLAN.md          — Implementation plan (Phases 1-9, including Phase 5.5)
docs/RECEIPT-INTEGRATION-STATE.md         — This document
CLAUDE.md                                 — Project overview
```

---

## 10. Test Status

**All 302 tests pass across 41 test suites.**

Receipt module tests added (2026-03-12):
- `tests/tax-allocator.test.ts` — 14 tests (proportional allocation, taxable flags, rounding, edge cases)
- `tests/matching-service.test.ts` — 28 tests (confidence levels, YYYYMMDD dates, vendor normalization, apostrophe stripping, payee resolution, conflict resolution, unmatch/rematch, overridesExisting flag)
- `tests/split-plan-builder.test.ts` — 9 tests (approved filtering, additional charges, fallback categories, rounding)
- `tests/line-item-classifier.test.ts` — 10 tests (cleanDescription OCR cleanup, buildSearchQuery formatting)
- `tests/batch-service.test.ts` — 16 tests (filter resolution, batch approve/reject/apply/unmatch, error collection, limit enforcement)

---

## 11. Environment & Credentials

The `.env` file in the project root contains all necessary credentials:
```
VERYFI_USERNAME=<email>
VERYFI_PASSWORD=<password>
VERYFI_TOTP_SECRET=<base32 TOTP secret>
```

These are protected by:
1. `.gitignore` — excludes `.env`
2. `.git/info/exclude` — local git exclude for `.env` and `.mcp.json`
3. `.git/hooks/pre-commit` — blocks `.env` and `.mcp.json` from staging even with `git add -f`

To enable the receipt pipeline, add to `.env`:
```
RECEIPT_CONNECTORS=veryfi
FEATURES=["classifyOnStartup", "syncAccountsBeforeClassify", "receiptMatching", "lineItemClassification"]
```

---

## 12. What Comes Next

See `docs/RECEIPT-INTEGRATION-PLAN.md` for the full plan. Summary:

- [x] ~~Push branch and create PR~~ — PR #2 open
- [x] ~~Add unit tests~~ — 51 tests added
- [x] ~~Live test Veryfi fetch~~ — 31 receipts fetched
- [x] ~~Fix matching bugs~~ — date parsing, vendor normalization, payee resolution
- [x] ~~Retroactive matching~~ — already-categorized transactions with overridesExisting flag
- [x] ~~**Phase 5.5**: Fallback classification pipeline~~ — 4-tier fallback (web search + LLM, rules, majority category, manual review) + 1-2 item receipt special case
- [x] ~~**Phase 6**: Batch operations~~ — 6 batch API endpoints, filter-based selection, re-classification, BatchService orchestrator
- [x] ~~**Phase 7**: Review UI receipt views~~ — match queue, detail page, unmatched receipts, dashboard, bulk actions wired to batch API
- [ ] **Phase 8**: Live testing (LLM classification, fallback chain, split apply/rollback, end-to-end)
- [ ] **Phase 9**: Production deployment to dh01
