# Transaction Cache & Persistent API Connection Design

## Problem Statement

Every web UI request that needs Actual Budget transaction data currently:

1. Calls `createTempApiService()` which re-initializes the engine and
   **re-downloads the entire budget** from the Actual Budget server
2. Calls `getTransactions(account, '1990-01-01', '2030-01-01')` for every
   account — fetching ALL transactions across ALL accounts
3. Also fetches all payees, categories, and accounts for name resolution
4. Filters in memory to the few transaction IDs actually needed
5. Shuts down the connection

This happens on:
- Every queue page load (lazy-load `POST /api/transactions/bulk-details`)
- Every detail page load (lazy-load `GET /api/transactions/:id/details`)
- Every "Reset & Rematch" action
- Every cron run (matching step)

## Current Architecture

```
Web request → createTempApiService()
                ├── init({ dataDir, serverURL, password })
                ├── downloadBudget(budgetId)           ← FULL RE-DOWNLOAD
                ├── getAccounts()
                ├── getTransactions(acct, 1990, 2030)  ← ALL TRANSACTIONS × N ACCOUNTS
                ├── getPayees()
                ├── getCategoryGroups()
                ├── ... find the 20 IDs we need ...
                └── shutdown()
```

Each cycle is ~2-5 seconds depending on budget size and network latency.

## Available API Capabilities

### What exists
- `getTransactions(accountId, startDate, endDate)` — all three params are
  optional in the handler (falsy = no filter). No incremental/delta support.
- `aqlQuery(q('transactions').filter(...))` — full query builder with filter,
  limit, offset, orderBy. Can filter by `id`, `category`, `account`, `date`,
  any field. This is the efficient path.
- `internal.db.getTransaction(id)` — single-row primary-key lookup (unofficial
  but accessible).
- `sync()` — pulls changes from Actual Budget sync server into local SQLite
  copy. Returns void (no delta info surfaced to caller).

### What does NOT exist
- No `updated_at` or `modified_at` field on transactions
- No "changed since" or delta API
- No webhook or event system for change notifications

## Design

### 1. Persistent API Connection

Replace `createTempApiService()` (init+download+shutdown per request) with a
single long-lived connection that stays open for the lifetime of the process.

```typescript
class ActualBudgetConnection {
  private initialized = false;
  private lastSync = 0;
  private syncIntervalMs = 5 * 60 * 1000; // 5 minutes

  async ensureReady(): Promise<void> {
    if (!this.initialized) {
      await actualApiClient.init({ dataDir, serverURL, password });
      await actualApiClient.downloadBudget(budgetId);
      this.initialized = true;
      this.lastSync = Date.now();
    }

    // Periodic sync to pick up external changes
    if (Date.now() - this.lastSync > this.syncIntervalMs) {
      await actualApiClient.sync();
      this.lastSync = Date.now();
      this.cache.invalidateAll(); // sync may have changed anything
    }
  }

  async shutdown(): Promise<void> {
    if (this.initialized) {
      await actualApiClient.shutdown();
      this.initialized = false;
    }
  }
}
```

**Concurrency**: The existing `createTempApiService` uses the singleton
`actualApiClient` module — there's only one connection. The persistent
connection must be guarded with a mutex/lock to prevent concurrent
operations (e.g., cron run + web request simultaneously).

### 2. In-Memory Cache with TTL

Cache resolved transaction data (with payee/account/category names already
resolved) in a Map with per-entry TTL.

```typescript
class TransactionCache {
  private entries = new Map<string, { data: TransactionSummary; expiresAt: number }>();
  private ttlMs = 5 * 60 * 1000; // 5 minutes

  get(id: string): TransactionSummary | null {
    const entry = this.entries.get(id);
    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) this.entries.delete(id);
      return null;
    }
    return entry.data;
  }

  set(id: string, data: TransactionSummary): void {
    this.entries.set(id, { data, expiresAt: Date.now() + this.ttlMs });
  }

  evict(id: string): void {
    this.entries.delete(id);
  }

  invalidateAll(): void {
    this.entries.clear();
  }
}
```

### 3. Lookup Tables Cache

Payees, categories, and accounts change rarely. Cache them with a longer TTL
(15 minutes) and invalidate on sync.

```typescript
interface LookupTables {
  payeeMap: Map<string, string>;      // payee ID → name
  categoryMap: Map<string, string>;   // category ID → name
  accountMap: Map<string, string>;    // account ID → name
  loadedAt: number;
}
```

### 4. Targeted Queries via aqlQuery

Instead of fetching all transactions and filtering in memory, use the AQL
query builder to fetch only what's needed:

```typescript
// Bulk lookup by IDs
async function getTransactionsByIds(ids: string[]): Promise<TransactionEntity[]> {
  // Check cache first
  const cached: TransactionSummary[] = [];
  const uncachedIds: string[] = [];
  for (const id of ids) {
    const hit = cache.get(id);
    if (hit) cached.push(hit);
    else uncachedIds.push(id);
  }

  if (uncachedIds.length === 0) return cached;

  // Fetch only uncached IDs from Actual Budget
  // aqlQuery doesn't support IN() directly, so batch in chunks
  const fetched = [];
  for (const id of uncachedIds) {
    const { data } = await aqlQuery(
      q('transactions').filter({ id }).select('*')
    );
    if (data.length > 0) fetched.push(data[0]);
  }

  // Resolve names and cache
  const lookups = await getLookupTables();
  for (const tx of fetched) {
    const resolved = resolveTransaction(tx, lookups);
    cache.set(tx.id, resolved);
    cached.push(resolved);
  }

  return cached;
}
```

### 5. Cache Invalidation on Our Writes

When actual-ai writes to Actual Budget (apply split, update category, rollback),
evict the affected transaction IDs from cache:

```typescript
// In onApply callback
await apiService.updateTransaction(c.transactionId, { ... });
cache.evict(c.transactionId);

// In applySplit
await splitTransactionService.applySplit(matchId);
cache.evict(originalTransactionId);
// New split sub-transactions won't be in cache — that's fine,
// they'll be fetched fresh on next access

// In rollbackSplit
cache.evict(transactionId);
```

### 6. Sync-Triggered Invalidation

When `sync()` runs (every 5 minutes), clear the entire cache since we
don't know what changed externally:

```typescript
await actualApiClient.sync();
cache.invalidateAll();
lookupTablesCache = null;
```

This is conservative but correct. The 5-minute sync interval means at most
5 minutes of stale data.

## Implementation Plan

### Step 1: Create ActualBudgetConnection class

New file: `src/actual-budget-connection.ts`

- Wraps init/download/sync/shutdown lifecycle
- Mutex for concurrent access (cron vs web requests)
- Periodic sync with configurable interval
- Exposes `getApi()` for raw access when needed

### Step 2: Create TransactionCache

Add to the connection class or as a separate utility.

- Per-ID TTL cache for resolved transaction summaries
- Lookup tables cache for payees/categories/accounts (longer TTL)
- `evict(id)`, `invalidateAll()`, `get(id)`, `set(id, data)`

### Step 3: Create efficient query methods

- `getTransactionsByIds(ids[])` — cache-first, then aqlQuery for misses
- `getTransactionById(id)` — single ID variant
- `getUncategorizedTransactions()` — `q('transactions').filter({ category: null })`
- `getAllTransactionsForMatching()` — full fetch but cached

### Step 4: Replace createTempApiService

- Remove `createTempApiService()` from `app.ts`
- Replace all call sites with the persistent connection
- Update web server deps to use cached methods
- Update cron runner to use the shared connection

### Step 5: Wire cache invalidation

- `onApply` → evict applied transaction IDs
- `applySplit` → evict original + new transaction IDs
- `rollbackSplit` → evict transaction ID
- `sync()` → clear all caches

## Files to Modify

| File | Changes |
|------|---------|
| `src/actual-budget-connection.ts` | NEW — persistent connection + cache |
| `app.ts` | Remove `createTempApiService`, use shared connection |
| `src/container.ts` | Wire connection as shared singleton |
| `src/web/server.ts` | Update deps to use cached query methods |

## Risks

1. **Stale data**: Cache may show old categories for up to 5 minutes after
   an external change in Actual Budget. Acceptable for a Review UI.

2. **Memory**: Caching all transactions in memory could use significant RAM
   if there are tens of thousands. The per-ID cache with TTL eviction
   mitigates this — only actively viewed transactions are cached.

3. **Concurrency**: The Actual Budget API client is a singleton module. A
   mutex is required to prevent cron and web requests from interleaving
   API calls. This is the main implementation risk.

4. **Connection loss**: If the Actual Budget server goes down, the persistent
   connection needs graceful recovery (re-init on next access attempt).
