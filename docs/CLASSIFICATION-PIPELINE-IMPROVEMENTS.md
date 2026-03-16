# Classification Pipeline Improvements

## Problem Statement

The standard transaction classification pipeline has several issues that
waste LLM tokens, lack visibility, and miss reliability opportunities:

1. **Token waste in dryRun**: Every cron run re-sends ALL uncategorized
   transactions to the LLM because the filterer only checks Actual Budget
   for existing categories. In dryRun mode, categories are never written to
   Actual Budget, so the same 2,838 transactions get re-classified every
   4 hours — burning LLM tokens on identical results.

2. **No confidence scores**: The standard transaction classifier returns a
   category name but no confidence level. The receipt line-item classifier
   has high/medium/low confidence via structured output, but the main
   pipeline does not. Without confidence, there's no way to auto-apply
   high-confidence results or flag low-confidence ones for review.

3. **No retry on failed writes**: If writing a classification to Actual
   Budget fails (API down, network error, budget locked), the result is
   lost. The next cron run re-classifies from scratch instead of retrying
   the already-computed result.

4. **No visibility into pending classifications**: The UI shows
   classifications after they're stored, but there's no indicator of how
   many are waiting to be applied, or a one-click way to retry failed ones.

5. **No granular automation control**: The cron job is all-or-nothing.
   Users can't selectively enable/disable receipt fetching, matching,
   or transaction classification independently. These should be persistent
   toggles in the UI, stored in SQLite.

## Current Architecture

### What exists

**`classifications.db`** (SQLite, separate from `receipts.db`):
```sql
CREATE TABLE classifications (
  id TEXT PRIMARY KEY,
  transactionId TEXT NOT NULL,       -- links to Actual Budget transaction
  date TEXT,
  amount INTEGER,
  payee TEXT,
  importedPayee TEXT,
  notes TEXT,
  accountName TEXT,
  suggestedCategoryId TEXT,          -- the LLM's answer
  suggestedCategoryName TEXT,
  suggestedCategoryGroup TEXT,
  classificationType TEXT,           -- rule, existing, new
  matchedRuleName TEXT,
  newCategoryName TEXT,
  newGroupName TEXT,
  newGroupIsNew INTEGER,
  status TEXT DEFAULT 'pending',     -- pending, approved, rejected, applied
  classifiedAt TEXT,
  reviewedAt TEXT,
  appliedAt TEXT,
  runId TEXT
);
```

**Write path** (`app.ts` lines 60-79):
- `classificationStore.clearPendingForTransaction(tx.id)` — clears old pending
- `classificationStore.insert(...)` — stores new LLM result as `pending`
- This happens for EVERY transaction the LLM processes, even in dryRun

**Transaction filterer** (`transaction-filterer.ts`):
- Filters to transactions with no category in Actual Budget
- Filters out transfers, starting balances, parent transactions, off-budget
- Filters out `#actual-ai-miss` tagged transactions (unless `rerunMissedTransactions`)
- Does NOT check `classifications.db` — this is the root cause

**Apply path** (`app.ts` lines 169-200, `onApply` callback):
- User selects classifications in Review UI → clicks Apply
- Writes `suggestedCategoryId` + notes to Actual Budget via `updateTransaction()`
- Marks classifications as `applied` in `classifications.db`

### What the receipt pipeline does differently

The receipt line-item classifier (`line-item-classifier.ts`) uses:
- Structured output via `generateObject()` + Zod schema
- Confidence levels: high, medium, low
- 4-tier fallback pipeline for low-confidence items
- Separate approval workflow (classify → approve → apply)

## Improvement Plan

### Fix 1: Skip already-classified transactions (CRITICAL — stops token waste)

**Problem**: Transaction filterer doesn't check `classifications.db`.

**Fix**: After filtering uncategorized transactions from Actual Budget, also
filter out any that already have a non-rejected classification in
`classifications.db`.

**Implementation**:
- Add `getClassifiedTransactionIds(): Set<string>` to `ClassificationStore`
  - Query: `SELECT DISTINCT transactionId FROM classifications WHERE status != 'rejected'`
- In `TransactionFilterer.filterUncategorized()`, accept an optional
  `alreadyClassifiedIds: Set<string>` parameter
- Add a filter step: skip transactions whose ID is in the set
- In `TransactionService.processTransactions()`, call the new store method
  and pass the set to the filterer

**Result**: In dryRun mode, each transaction is classified exactly once. On
subsequent runs, the filterer sees the existing classification and skips it.
Reduces 2,838 LLM calls per run to ~0 (only new transactions since last run).

**Edge cases**:
- Rejected classifications: DO re-classify (user explicitly rejected)
- Transaction category removed in Actual Budget: the transaction becomes
  uncategorized again AND has no pending classification → re-classify
- Manual override: user can always re-trigger via UI

### Fix 2: Add confidence scores to standard classifier

**Problem**: No way to distinguish high-confidence rule matches from
uncertain LLM guesses.

**Fix**: Add a `confidence` column to the `classifications` table and
populate it from two sources:

1. **Rule matches** (`classificationType: 'rule'`): confidence = `high`
   (rules are deterministic)
2. **Existing category matches** (`classificationType: 'existing'`):
   confidence = `high` (matched by payee history)
3. **LLM classifications**: Ask the LLM to include a confidence level
   in its response. Modify the prompt template to request:
   ```
   Return your answer as: category_name (confidence: high|medium|low)
   ```
   Parse the confidence from the response. Default to `medium` if not
   provided (backward compatible with models that don't follow the format).

**Schema change**:
```sql
ALTER TABLE classifications ADD COLUMN confidence TEXT;
-- Values: high, medium, low, or NULL (legacy records)
```

**UI impact**: Show confidence badge next to each classification in the
Review UI, matching the receipt detail page's visual pattern.

### Fix 3: Retry mechanism for failed writes

**Problem**: Failed writes to Actual Budget lose the classification result.

**Fix**: Add a `writeError` column to track failures, and a retry mechanism.

**Schema change**:
```sql
ALTER TABLE classifications ADD COLUMN writeError TEXT;
-- NULL = no error, non-NULL = last error message
```

**Write flow change** (in `onApply` callback):
- On success: set `status = 'applied'`, `appliedAt = now`
- On failure: keep `status = 'approved'`, set `writeError = error.message`
- Failed classifications remain `approved` (not `applied`) so they're
  retried on next attempt

**Retry**: Add a `retryFailed()` method that re-attempts all classifications
with `status = 'approved' AND writeError IS NOT NULL`.

**Auto-retry on cron**: At the end of each cron run, attempt to apply any
`approved` classifications that have `writeError` (i.e., previously failed).

### Fix 4: Unposted count in UI

**Problem**: No visibility into pending/failed classifications.

**Fix**: Add a status indicator to the nav bar (similar to the cron toggle)
showing the count of classifications ready to apply.

**Display**: `"42 pending | 3 failed"` in the nav bar, clickable to go to
the classifications page filtered by status.

**API**: `GET /api/classification-stats` returning:
```json
{
  "pending": 42,
  "approved": 5,
  "failed": 3,
  "applied": 1200,
  "rejected": 15
}
```

### Fix 5: Persistent automation toggles

**Problem**: Cron job is all-or-nothing. The in-memory cron toggle resets on
container restart.

**Fix**: Store automation settings in SQLite (`receipts.db` or a new
`settings.db`) with a simple key-value table:

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Settings**:
| Key | Default | Description |
|-----|---------|-------------|
| `cron.enabled` | `true` | Master cron toggle |
| `cron.autoFetchReceipts` | `true` | Fetch receipts from Veryfi on cron |
| `cron.autoMatchReceipts` | `true` | Match receipts to transactions on cron |
| `cron.autoClassifyTransactions` | `true` | Run LLM transaction classifier on cron |
| `cron.autoClassifyLineItems` | `false` | Run LLM line-item classifier on cron (expensive) |
| `cron.autoApplyHighConfidence` | `false` | Auto-apply high-confidence classifications |

**API**:
- `GET /api/settings` — returns all settings
- `PATCH /api/settings` — update one or more settings

**UI**: Settings panel (accessible from nav or dashboard) with toggle
switches for each setting. Changes take effect immediately and persist
across container restarts.

**Cron integration**: `runClassification()` checks each toggle before
executing each step:
```typescript
async function runClassification() {
  if (!getSetting('cron.enabled')) return;

  if (getSetting('cron.autoFetchReceipts')) {
    await receiptFetchService.fetchAll();
  }
  if (getSetting('cron.autoMatchReceipts')) {
    // ... matching logic
  }
  if (getSetting('cron.autoClassifyTransactions')) {
    await actualAi.classify();
  }
  // etc.
}
```

## Implementation Order

```
Fix 1: Skip already-classified transactions     ← CRITICAL, do first
  │    (stops token waste immediately)
  │
Fix 5: Persistent automation toggles            ← HIGH, replaces in-memory toggle
  │    (gives user control before re-enabling cron)
  │
Fix 4: Unposted count in UI                     ← MEDIUM, visibility
  │
Fix 3: Retry mechanism for failed writes         ← MEDIUM, reliability
  │
Fix 2: Add confidence scores                     ← LOW, nice-to-have
       (requires prompt changes + response parsing)
```

Fix 1 is the emergency — it stops the token burn. Fix 5 gives the user
control over what runs automatically before re-enabling the cron job.
Fixes 3 and 4 improve reliability and visibility. Fix 2 is the most
invasive (touches the LLM prompt and response parsing) and least urgent.

## Files to Modify

| Fix | Files |
|-----|-------|
| 1 | `src/web/classification-store.ts`, `src/transaction/transaction-filterer.ts`, `src/transaction-service.ts` |
| 2 | `src/web/classification-store.ts` (migration), `src/templates/prompt.hbs`, `app.ts` (parse confidence), `src/web/views/renderer.ts` (badge) |
| 3 | `src/web/classification-store.ts` (migration + retry method), `app.ts` (onApply error handling, auto-retry) |
| 4 | `src/web/server.ts` (stats endpoint), `src/web/views/renderer.ts` (nav indicator), `src/web/views/receipt-renderer.ts` (nav indicator) |
| 5 | `src/receipt/receipt-store.ts` (settings table + methods), `app.ts` (check settings in runClassification), `src/web/server.ts` (settings API), UI (settings panel) |
