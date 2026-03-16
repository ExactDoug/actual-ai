/**
 * Persistent connection to Actual Budget with in-memory transaction cache.
 *
 * Replaces the createTempApiService() pattern (init+download+shutdown per
 * request) with a single long-lived connection. Caches resolved transaction
 * data with TTL to avoid redundant API calls on every page load.
 */

import * as actualApiClient from '@actual-app/api';
import type { TransactionEntity } from '@actual-app/api/@types/loot-core/src/types/models';

export interface TransactionSummary {
  amount?: number;
  date?: string;
  payeeName?: string;
  importedPayee?: string;
  accountName?: string;
  categoryId?: string;
  categoryName?: string;
  isParent?: boolean;
  subtransactions?: { amount: number; categoryId?: string; categoryName?: string }[];
}

interface LookupTables {
  payeeMap: Map<string, string>;
  categoryMap: Map<string, string>;
  accountMap: Map<string, string>;
  loadedAt: number;
}

interface CacheEntry {
  data: TransactionSummary;
  expiresAt: number;
}

class ActualBudgetConnection {
  private serverURL: string;
  private password: string;
  private budgetId: string;
  private e2ePassword: string;
  private dataDir: string;

  private initialized = false;
  private lastSync = 0;
  private syncIntervalMs: number;
  private cacheTtlMs: number;
  private lookupTtlMs: number;

  private txCache = new Map<string, CacheEntry>();
  private lookupTables: LookupTables | null = null;
  private busy = false;
  private busyQueue: Array<() => void> = [];

  constructor(config: {
    serverURL: string;
    password: string;
    budgetId: string;
    e2ePassword?: string;
    dataDir: string;
    syncIntervalMs?: number;
    cacheTtlMs?: number;
    lookupTtlMs?: number;
  }) {
    this.serverURL = config.serverURL;
    this.password = config.password;
    this.budgetId = config.budgetId;
    this.e2ePassword = config.e2ePassword ?? '';
    this.dataDir = config.dataDir;
    this.syncIntervalMs = config.syncIntervalMs ?? 5 * 60 * 1000;
    this.cacheTtlMs = config.cacheTtlMs ?? 5 * 60 * 1000;
    this.lookupTtlMs = config.lookupTtlMs ?? 15 * 60 * 1000;
  }

  // ── Mutex ────────────────────────────────────────────────────────

  private async acquireLock(): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.busyQueue.push(resolve);
    });
  }

  private releaseLock(): void {
    const next = this.busyQueue.shift();
    if (next) {
      next();
    } else {
      this.busy = false;
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  private async ensureReady(): Promise<void> {
    if (!this.initialized) {
      const fs = await import('fs');
      const applyDir = this.dataDir + 'apply/';
      if (!fs.existsSync(applyDir)) {
        fs.mkdirSync(applyDir, { recursive: true });
      }

      await actualApiClient.init({
        dataDir: applyDir,
        serverURL: this.serverURL,
        password: this.password,
      });

      if (this.e2ePassword) {
        await actualApiClient.downloadBudget(this.budgetId, { password: this.e2ePassword });
      } else {
        await actualApiClient.downloadBudget(this.budgetId);
      }

      this.initialized = true;
      this.lastSync = Date.now();
      console.log('[actual-budget] Connection initialized');
    }

    // Periodic sync
    if (Date.now() - this.lastSync > this.syncIntervalMs) {
      try {
        await actualApiClient.sync();
        this.lastSync = Date.now();
        this.invalidateAll();
        console.log('[actual-budget] Synced and cache cleared');
      } catch (err) {
        console.warn('[actual-budget] Sync failed, using cached data:', err);
      }
    }
  }

  /** Run a callback with the API connection, guarded by mutex. */
  async withApi<T>(fn: (api: typeof actualApiClient) => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      await this.ensureReady();
      return await fn(actualApiClient);
    } catch (err) {
      // If connection is broken, reset so next call re-initializes
      if (this.initialized && err instanceof Error && err.message.includes('No budget')) {
        console.warn('[actual-budget] Connection lost, will re-initialize on next call');
        this.initialized = false;
      }
      throw err;
    } finally {
      this.releaseLock();
    }
  }

  async shutdown(): Promise<void> {
    await this.acquireLock();
    try {
      if (this.initialized) {
        await actualApiClient.shutdown();
        this.initialized = false;
        this.invalidateAll();
        console.log('[actual-budget] Connection shut down');
      }
    } finally {
      this.releaseLock();
    }
  }

  // ── Cache ────────────────────────────────────────────────────────

  evict(id: string): void {
    this.txCache.delete(id);
  }

  invalidateAll(): void {
    this.txCache.clear();
    this.lookupTables = null;
  }

  private getCached(id: string): TransactionSummary | null {
    const entry = this.txCache.get(id);
    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) this.txCache.delete(id);
      return null;
    }
    return entry.data;
  }

  private setCached(id: string, data: TransactionSummary): void {
    this.txCache.set(id, { data, expiresAt: Date.now() + this.cacheTtlMs });
  }

  // ── Lookup tables ────────────────────────────────────────────────

  private async loadLookupTables(api: typeof actualApiClient): Promise<LookupTables> {
    if (this.lookupTables && Date.now() - this.lookupTables.loadedAt < this.lookupTtlMs) {
      return this.lookupTables;
    }

    const payees = await api.getPayees();
    const payeeMap = new Map<string, string>();
    for (const p of payees) {
      if (p.id && p.name) payeeMap.set(p.id, p.name);
    }

    const groups = await api.getCategoryGroups();
    const categoryMap = new Map<string, string>();
    for (const group of groups) {
      if ('categories' in group && Array.isArray(group.categories)) {
        for (const cat of group.categories as { id: string; name: string }[]) {
          categoryMap.set(cat.id, cat.name);
        }
      }
    }

    const accounts = await api.getAccounts();
    const accountMap = new Map<string, string>();
    for (const a of accounts) {
      if (a.id && a.name) accountMap.set(a.id, a.name);
    }

    this.lookupTables = { payeeMap, categoryMap, accountMap, loadedAt: Date.now() };
    return this.lookupTables;
  }

  private resolveTransaction(
    tx: TransactionEntity,
    lookups: LookupTables,
    allTransactions?: TransactionEntity[],
  ): TransactionSummary {
    const dateStr = String(tx.date ?? '');
    const formattedDate = /^\d{8}$/.test(dateStr)
      ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
      : dateStr;

    const acctId = (tx as unknown as { account?: string }).account;
    const entry: TransactionSummary = {
      amount: tx.amount,
      date: formattedDate,
      payeeName: tx.payee ? lookups.payeeMap.get(tx.payee) ?? '' : '',
      importedPayee: tx.imported_payee ?? '',
      accountName: acctId ? lookups.accountMap.get(acctId) ?? '' : '',
    };

    if (tx.is_parent && allTransactions) {
      entry.isParent = true;
      const subs = allTransactions.filter((t) => t.parent_id === tx.id);
      entry.subtransactions = subs.map((s) => ({
        amount: s.amount,
        categoryId: s.category ?? undefined,
        categoryName: s.category ? lookups.categoryMap.get(s.category) : undefined,
      }));
    } else if (tx.category) {
      entry.categoryId = tx.category;
      entry.categoryName = lookups.categoryMap.get(tx.category);
    }

    return entry;
  }

  // ── Public query methods ─────────────────────────────────────────

  /** Get resolved transaction summaries for multiple IDs. Cache-first. */
  async getTransactionsBulk(transactionIds: string[]): Promise<Record<string, TransactionSummary>> {
    const result: Record<string, TransactionSummary> = {};
    const uncachedIds: string[] = [];

    for (const id of transactionIds) {
      const cached = this.getCached(id);
      if (cached) {
        result[id] = cached;
      } else {
        uncachedIds.push(id);
      }
    }

    if (uncachedIds.length === 0) return result;

    // Fetch from Actual Budget — need all transactions for split resolution
    return this.withApi(async (api) => {
      const lookups = await this.loadLookupTables(api);

      const accounts = await api.getAccounts();
      let allTransactions: TransactionEntity[] = [];
      for (const account of accounts) {
        allTransactions = allTransactions.concat(
          await api.getTransactions(account.id, '1990-01-01', '2030-01-01'),
        );
      }

      const requestedSet = new Set(uncachedIds);
      for (const tx of allTransactions) {
        if (!requestedSet.has(tx.id)) continue;
        const resolved = this.resolveTransaction(tx, lookups, allTransactions);
        this.setCached(tx.id, resolved);
        result[tx.id] = resolved;
      }

      return result;
    });
  }

  /** Get a single resolved transaction summary. Cache-first. */
  async getTransactionDetails(transactionId: string): Promise<TransactionSummary | null> {
    const cached = this.getCached(transactionId);
    if (cached) return cached;

    const bulk = await this.getTransactionsBulk([transactionId]);
    return bulk[transactionId] ?? null;
  }

  /** Get all transactions for matching (uses full fetch, results NOT individually cached). */
  async getAllTransactionsForMatching(): Promise<{
    transactions: TransactionEntity[];
    payeeMap: Map<string, string>;
  }> {
    return this.withApi(async (api) => {
      const accounts = await api.getAccounts();
      let transactions: TransactionEntity[] = [];
      for (const account of accounts) {
        transactions = transactions.concat(
          await api.getTransactions(account.id, '1990-01-01', '2030-01-01'),
        );
      }
      const lookups = await this.loadLookupTables(api);
      return { transactions, payeeMap: lookups.payeeMap };
    });
  }

  /** Get categories for the UI (dropdown population, etc.). */
  async getCategories(): Promise<{ id: string; name: string; group: string }[]> {
    return this.withApi(async (api) => {
      const groups = await api.getCategoryGroups();
      const result: { id: string; name: string; group: string }[] = [];
      for (const group of groups) {
        if ('categories' in group && Array.isArray(group.categories)) {
          for (const cat of group.categories as { id: string; name: string }[]) {
            result.push({ id: cat.id, name: cat.name, group: group.name ?? '' });
          }
        }
      }
      return result;
    });
  }

  /** Get category groups for the line-item classifier. */
  async getCategoryGroups(): Promise<unknown[]> {
    return this.withApi(async (api) => api.getCategoryGroups());
  }

  /** Get payees map. */
  async getPayees(): Promise<Map<string, string>> {
    return this.withApi(async (api) => {
      const lookups = await this.loadLookupTables(api);
      return lookups.payeeMap;
    });
  }

  /** Update a transaction and evict from cache. */
  async updateTransaction(id: string, fields: Record<string, unknown>): Promise<void> {
    await this.withApi(async (api) => {
      await api.updateTransaction(id, fields);
    });
    this.evict(id);
  }

  /** Get accounts. */
  async getAccounts(): Promise<{ id: string; name: string; offbudget?: boolean }[]> {
    return this.withApi(async (api) => {
      const accounts = await api.getAccounts();
      return accounts.map((a) => ({ id: a.id, name: a.name, offbudget: a.offbudget }));
    });
  }

  /** Get rules for classification. */
  async getRules(): Promise<unknown[]> {
    return this.withApi(async (api) => api.getRules());
  }
}

export default ActualBudgetConnection;
