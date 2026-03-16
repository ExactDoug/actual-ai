# Receipt Matching Algorithm Redesign

## Problem Statement

The current matching algorithm uses a greedy serial approach that produces
incorrect matches in common real-world scenarios. Key failures:

1. **Cross-year matches**: Transactions from 1990-2030 (40 years) are all
   candidates. A receipt matches any transaction within 5 cents regardless of
   date, producing `possible`-confidence matches across years.

2. **Greedy serial with no fallback**: Each receipt independently picks its best
   transaction. When multiple receipts want the same transaction, the conflict
   resolver picks one winner and **permanently discards the losers** — no retry
   with their second-best candidate. In the "daily Arby's" scenario (5 receipts
   Mon-Fri at $8.64, 5 transactions Tue-Sat), only 1 match is created and 4
   receipts are orphaned.

3. **No date tiebreaker**: When candidates tie on confidence and amount
   difference, the sort has no date proximity tiebreaker. The first candidate in
   array order wins — which is essentially random.

4. **No collective reasoning**: Each receipt is scored in isolation. The
   algorithm cannot reason about groups of receipts and transactions together to
   find the most logical overall assignment.

## Current Algorithm Summary

```
matchAll(transactions):
  1. Load unmatched receipts from SQLite (no ORDER BY — undefined order)
  2. Filter transactions: remove already-matched and zero-amount
  3. For each receipt:
     - Score against ALL available transactions
     - Amount within toleranceCents (5¢) is the ONLY hard gate
     - Confidence: exact (amt+date+vendor), probable (amt+1), possible (amt only)
     - Sort by confidence, then amountDiff — pick candidates[0]
  4. Single-pass conflict resolution:
     - If two receipts want same tx, compare confidence then amountDiff
     - Loser is deleted from candidatesByReceipt — no fallback
  5. Create matches for winners
```

**Key parameters** (from `config.ts`):
- `RECEIPT_MATCH_TOLERANCE_CENTS`: default 5
- `RECEIPT_DATE_TOLERANCE_DAYS`: default 1
- `RECEIPT_AUTO_MATCH`: default true

**Data available but unused**:
- `ocr_score` (78% of receipts, range 0.71-0.98, in `receiptData` JSON blob)
- `tipAmount` (explains amount mismatches when tip added at terminal)
- `vendorId` / `business_id` (stable vendor key, 199 unique vs 131 names)
- Card last-4 digits (`ocr_card` in receiptData, 86% populated)
- `accounting_entry_type` (debit vs credit — purchase vs refund)

## Redesigned Algorithm: 3-Phase Collective Matching

### Overview

Replace the single greedy pass with a 3-phase pipeline. Each phase operates on
the **remaining unmatched pool** after the previous phase has consumed its
matches. Within each phase, matching is collective (considers all candidates
together) rather than serial.

```
Phase 1: Exact Match     → high confidence, unambiguous 1-to-1 pairings
Phase 2: Structural Match → vendor+amount groups matched chronologically
Phase 3: Fuzzy Match      → scored matrix assignment for remaining candidates
```

### Phase 1: Exact Match

**Goal**: Match receipts where amount, date, and vendor all agree. These are
unambiguous and can be committed with high confidence.

**Criteria**:
- Amount: `|receipt.totalAmount - |tx.amount|| <= toleranceCents`
- Date: `daysBetween(receipt.date, tx.date) <= 1` (tight window)
- Vendor: `vendorMatch()` returns true (existing substring logic)
- All three must pass

**Process**:
1. Build a score for every (receipt, transaction) pair that passes all three
   criteria.
2. Score = `(1 / (1 + amountDiff)) * (1 / (1 + daysDiff))` — prefer exact
   penny and same-day matches.
3. Sort all candidate pairs by score descending.
4. Greedy assignment: take the highest-scoring pair, commit it, remove both
   receipt and transaction from the pool. Repeat.
5. Record matches with confidence `'exact'`.

**Why greedy works here**: By definition, all candidates in this phase have
full signal agreement. Conflicts are rare and the score tiebreaker (closer
amount, closer date) is sufficient.

**Expected yield**: ~60-70% of receipts based on corpus analysis.

### Phase 2: Structural Match (Vendor-Group Chronological)

**Goal**: Resolve the "daily Arby's" problem — same vendor, same amount,
consecutive days. This is a sequencing problem, not an optimization problem.

**Process**:
1. Group remaining unmatched receipts by `(normalizedVendor, roundedAmount)`
   where `roundedAmount = Math.round(receipt.totalAmount / toleranceCents) * toleranceCents`.
2. For each group, find all remaining transactions that:
   - Match the vendor (via `vendorMatch()`)
   - Match the amount (within `toleranceCents`)
3. Within each group:
   - Sort receipts by date ascending.
   - Sort transactions by date ascending.
   - Two-pointer sweep: advance both pointers together.
     - If `daysBetween(receipt.date, tx.date) <= structuralToleranceDays` (default 3):
       match them, advance both pointers.
     - If receipt date is earlier than tx date minus tolerance: receipt has no
       match in this group, advance receipt pointer only.
     - If tx date is earlier than receipt date minus tolerance: transaction has
       no receipt in this group, advance tx pointer only.
4. Record matches with confidence `'probable'`.

**Why chronological ordering is correct**: When amount and vendor are identical,
the only distinguishing signal is time. A receipt from Monday most likely
corresponds to the transaction closest to Monday, not to one from Friday. The
two-pointer sweep enforces this natural temporal ordering.

**Handling posting delays**: Bank transactions typically post 0-2 days after
purchase (91% within 1 day per corpus analysis). The two-pointer sweep with a
3-day tolerance naturally handles this — a Monday receipt will match a Tuesday
or Wednesday transaction before advancing past it.

**Expected yield**: ~15-20% of receipts (repeat-vendor same-amount clusters).

### Phase 3: Fuzzy Match (Scored Assignment)

**Goal**: Handle remaining unmatched receipts where only partial signals agree.
These require scoring and human review.

**Process**:
1. Build a score matrix for all remaining (receipt, transaction) pairs.
2. Score each pair on three weighted signals:

   **Amount score** (weight: 0.50):
   ```
   amountDiff = |receipt.totalAmount - |tx.amount||
   if amountDiff == 0:              1.00  (exact penny)
   if amountDiff <= 1:              0.98  (rounding)
   if amountDiff <= toleranceCents: 0.90  (within tolerance)
   if amountDiff <= tipAdjusted:    0.70  (tip explains gap — check receiptData.tip)
   else:                            0.00  (no match)
   ```
   If amount score is 0, the pair is excluded entirely.

   **Date score** (weight: 0.30):
   ```
   days = daysBetween(receipt.date, tx.date)
   if days <= 1:   1.00
   if days <= 3:   0.80
   if days <= 7:   0.50
   if days <= 14:  0.20
   if days <= 30:  0.05  (very weak — date is almost noise at this range)
   else:           0.00  (hard cap — no match beyond 30 days)
   ```

   **Vendor score** (weight: 0.20):
   ```
   if vendorMatch() (existing substring logic): 1.00
   if jaroWinkler(normalized) >= 0.85:          0.70  (fuzzy — catches OCR typos)
   if tokenOverlap(normalized) >= 0.5:          0.50  (partial word overlap)
   else:                                        0.00
   ```

3. Composite: `0.50 * amountScore + 0.30 * dateScore + 0.20 * vendorScore`.
4. Filter: exclude pairs with composite < 0.50 (the "unmatched penalty"
   threshold).
5. Sort all remaining pairs by composite score descending.
6. Greedy assignment: take the highest-scoring pair, commit it, remove both from
   pool. Repeat until no pairs remain above threshold.
7. Record matches with confidence `'possible'`.

**Hard date cap at 30 days**: No match is created for receipt-transaction pairs
more than 30 days apart, regardless of amount or vendor agreement. This prevents
the cross-year matching problem entirely. If a receipt and transaction are 30+
days apart, they are not the same purchase.

**OCR date error consideration**: If vendor and amount match exactly but date is
30+ days apart, the date _could_ have an OCR error — but we cannot conclude
that. The match is simply not created. The user can manually rematch via the
Review UI if they determine the OCR date was wrong. This keeps the algorithm
honest: it matches based on what the data says, not on speculation about what
the data might mean.

**Expected yield**: ~5-10% of additional matches.

### Unmatched Receipts

Receipts with no candidate pair above the threshold after all three phases are
marked as unmatched. This is the correct outcome — not every receipt will have a
corresponding transaction (and vice versa).

## Additional Improvements

### 1. Transaction Date Pre-Filtering

**Current**: `app.ts` fetches transactions from 1990-01-01 to 2030-01-01.

**Change**: Compute a date window based on the oldest unmatched receipt date,
with a buffer:
```typescript
const oldestReceiptDate = minDate(unmatchedReceipts.map(r => r.date));
const startDate = subtractDays(oldestReceiptDate, 30);  // 30-day buffer
const endDate = today();
```

This reduces the transaction pool from potentially thousands to a relevant
subset.

### 2. Date Proximity as Tiebreaker

Add `daysDiff` to `CandidateMatch` and use it as a third sort key after
confidence and amountDiff. This makes the sort deterministic when amount
differences are equal.

### 3. Deterministic Receipt Ordering

Add `ORDER BY date ASC, id ASC` to `getUnmatchedReceipts()` query. This ensures
consistent behavior regardless of SQLite rowid ordering.

### 4. Vendor ID Learning (Future)

Build a `vendor_payee_map` table from confirmed matches: when a user approves or
manually rematches, record the mapping `(vendorId, payeeName)`. In future
matching runs, use this learned mapping as an additional vendor signal. This
self-improves over time as more matches are confirmed.

### 5. OCR Score Integration (Future)

Extract `meta.extracted_images[0].ocr_score` from `receiptData` during fetch.
Store as a column in the receipts table. Use it to cap confidence:
- `ocr_score < 0.80`: never `exact`, cap at `probable`
- `ocr_score < 0.70`: cap at `possible`, flag for review

### 6. Card Last-4 Signal (Future)

Extract `ocr_card` (last 4 digits) from receipt data. Extract last 4 digits from
Actual Budget account name. When both are present and equal, boost vendor score.
When both are present and different, penalize. This is available on 86% of
receipts and is a very strong signal.

## Interface Changes

### Updated `Transaction` Interface

```typescript
interface Transaction {
  id: string;
  amount: number;
  date: string | number;
  payee?: string;
  imported_payee?: string;
  hasCategory?: boolean;
  categoryId?: string;
  // Future: accountName for card-last-4 matching
}
```

No changes to the Transaction interface in this iteration.

### Updated `MatchSummary` Interface

```typescript
interface MatchSummary {
  matched: number;
  exact: number;
  probable: number;
  possible: number;
  unmatched: number;
  // New: per-phase breakdown
  phase1Matched: number;
  phase2Matched: number;
  phase3Matched: number;
}
```

### Updated `CandidateMatch` Interface

```typescript
interface CandidateMatch {
  transactionId: string;
  receiptId: string;
  confidence: MatchConfidence;
  amountDiff: number;
  daysDiff: number;            // NEW: for tiebreaking
  amountScore: number;         // NEW: for Phase 3 scoring
  dateScore: number;           // NEW: for Phase 3 scoring
  vendorScore: number;         // NEW: for Phase 3 scoring
  compositeScore: number;      // NEW: for Phase 3 scoring
  overridesExisting: boolean;
  categoryId?: string;
}
```

### New Config Parameters

| Variable | Env Var | Default | Purpose |
|----------|---------|---------|---------|
| `receiptStructuralToleranceDays` | `RECEIPT_STRUCTURAL_TOLERANCE_DAYS` | `3` | Phase 2 date window |
| `receiptMaxDateGapDays` | `RECEIPT_MAX_DATE_GAP_DAYS` | `30` | Hard cap for Phase 3 |
| `receiptFuzzyMatchThreshold` | `RECEIPT_FUZZY_MATCH_THRESHOLD` | `0.50` | Minimum composite score |

## Implementation Plan

### Step 1: Refactor `matchAll()` into Phase Structure

Extract the current logic into a private method. Create the 3-phase pipeline in
`matchAll()`:

```typescript
matchAll(transactions: Transaction[]): MatchSummary {
  const { unmatchedReceipts, availableTransactions } = this.preparePool(transactions);

  const summary = createEmptySummary();
  let remainingReceipts = [...unmatchedReceipts];
  let remainingTransactions = [...availableTransactions];

  // Phase 1
  const phase1 = this.phaseExactMatch(remainingReceipts, remainingTransactions);
  this.commitMatches(phase1.matches, 'exact', summary);
  remainingReceipts = phase1.unmatchedReceipts;
  remainingTransactions = phase1.unmatchedTransactions;

  // Phase 2
  const phase2 = this.phaseStructuralMatch(remainingReceipts, remainingTransactions);
  this.commitMatches(phase2.matches, 'probable', summary);
  remainingReceipts = phase2.unmatchedReceipts;
  remainingTransactions = phase2.unmatchedTransactions;

  // Phase 3
  const phase3 = this.phaseFuzzyMatch(remainingReceipts, remainingTransactions);
  this.commitMatches(phase3.matches, 'possible', summary);

  summary.unmatched = unmatchedReceipts.filter(r => r.totalAmount !== 0).length - summary.matched;
  return summary;
}
```

### Step 2: Implement Phase 1 (Exact Match)

Build all qualifying pairs, score, sort, greedy assign.

### Step 3: Implement Phase 2 (Structural Match)

Group by vendor+amount, sort within groups by date, two-pointer sweep.

### Step 4: Implement Phase 3 (Fuzzy Match)

Build score matrix, filter by threshold, greedy assign.

### Step 5: Add New Config Parameters

Add env vars for structural tolerance, max date gap, fuzzy threshold.

### Step 6: Add Jaro-Winkler for Phase 3 Vendor Scoring

Implement or import a Jaro-Winkler distance function for fuzzy vendor matching.

### Step 7: Update Tests

- Preserve all existing test assertions (behavior should improve, not regress)
- Add "daily Arby's" scenario: 5 same-vendor same-amount receipts with
  next-day posting — assert all 5 match correctly
- Add cross-year rejection test: receipt from 2022, transaction from 2025,
  same amount — assert no match created
- Add Phase 2 group test: mixed vendors with overlapping amounts
- Add Phase 3 scoring test: verify composite scores and threshold cutoff
- Add deterministic ordering test: same inputs always produce same outputs

### Step 8: Transaction Date Pre-Filtering

Update `app.ts` to compute a date window based on receipt dates instead of
hardcoding 1990-2030.

## Migration

The new algorithm is a drop-in replacement for the existing `matchAll()` method.
No database schema changes are required. The `MatchConfidence` type already
supports all needed values. Existing matches in the database are not affected —
the algorithm only operates on unmatched receipts.

The `unmatch()` and `rematch()` methods remain unchanged.

## Testing Strategy

All existing tests must continue to pass. The new algorithm should produce the
same or better results for every existing test case. New tests specifically
target:

1. Multi-receipt same-transaction conflict with fallback (the core bug fix)
2. Chronological ordering within vendor+amount groups
3. Hard date cap enforcement
4. Phase progression (exact candidates consumed before structural runs)
5. Deterministic output for identical inputs
6. Edge cases: zero amounts, empty vendors, single receipt, no transactions
