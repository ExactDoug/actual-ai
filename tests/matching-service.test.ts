import os from 'os';
import path from 'path';
import fs from 'fs';
import ReceiptStore from '../src/receipt/receipt-store';
import MatchingService from '../src/receipt/matching-service';

function createTempStore(): { store: ReceiptStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-test-'));
  const store = new ReceiptStore(dir);
  return { store, dir };
}

function insertReceipt(
  store: ReceiptStore,
  overrides: Partial<{
    externalId: string;
    providerId: string;
    vendorName: string;
    vendorId: string;
    totalAmount: number;
    date: string;
    currency: string;
    lineItemCount: number;
    taxAmount: number;
    receiptData: string;
    fetchedAt: string;
  }> = {},
): string {
  return store.upsertReceipt({
    externalId: overrides.externalId ?? '1',
    providerId: overrides.providerId ?? 'test',
    vendorName: overrides.vendorName ?? 'Test Vendor',
    vendorId: overrides.vendorId,
    totalAmount: overrides.totalAmount ?? 1000,
    date: overrides.date ?? '2025-01-15',
    currency: overrides.currency ?? 'USD',
    lineItemCount: overrides.lineItemCount ?? 1,
    taxAmount: overrides.taxAmount ?? 0,
    receiptData: overrides.receiptData ?? '{}',
    fetchedAt: overrides.fetchedAt ?? new Date().toISOString(),
  });
}

describe('MatchingService', () => {
  let store: ReceiptStore;
  let tempDir: string;

  beforeEach(() => {
    ({ store, dir: tempDir } = createTempStore());
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('matchAll', () => {
    it('should match receipt to transaction with exact confidence (amount + date + vendor)', () => {
      const receiptId = insertReceipt(store, {
        totalAmount: 2500,
        date: '2025-01-15',
        vendorName: 'Coffee Shop',
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -2500, date: '2025-01-15', payee: 'Coffee Shop' },
      ]);

      expect(summary.matched).toBe(1);
      expect(summary.exact).toBe(1);
      expect(summary.unmatched).toBe(0);

      const match = store.getMatchForReceipt(receiptId);
      expect(match).not.toBeNull();
      expect(match!.transactionId).toBe('tx-1');
      expect(match!.matchConfidence).toBe('exact');
    });

    it('should match with probable confidence (amount + date, no vendor)', () => {
      insertReceipt(store, {
        totalAmount: 5000,
        date: '2025-02-10',
        vendorName: 'Some Store',
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -5000, date: '2025-02-10', payee: 'Different Name' },
      ]);

      expect(summary.matched).toBe(1);
      expect(summary.probable).toBe(1);
    });

    it('should match with probable confidence (amount + vendor, date outside tolerance)', () => {
      insertReceipt(store, {
        totalAmount: 3000,
        date: '2025-03-01',
        vendorName: 'Target',
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -3000, date: '2025-03-05', payee: 'Target' },
      ]);

      expect(summary.matched).toBe(1);
      expect(summary.probable).toBe(1);
    });

    it('should match with possible confidence (amount only)', () => {
      insertReceipt(store, {
        totalAmount: 1500,
        date: '2025-01-01',
        vendorName: 'Vendor A',
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -1500, date: '2025-01-10', payee: 'Totally Different' },
      ]);

      expect(summary.matched).toBe(1);
      expect(summary.possible).toBe(1);
    });

    it('should not match when amount is outside tolerance', () => {
      insertReceipt(store, { totalAmount: 1000 });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -1010, date: '2025-01-15' },
      ]);

      expect(summary.matched).toBe(0);
      expect(summary.unmatched).toBe(1);
    });

    it('should match within amount tolerance', () => {
      insertReceipt(store, { totalAmount: 1000 });

      const service = new MatchingService(store, 10, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -1008, date: '2025-01-15' },
      ]);

      expect(summary.matched).toBe(1);
    });

    it('should use absolute value of transaction amount', () => {
      insertReceipt(store, { totalAmount: 2500 });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -2500, date: '2025-01-15' },
      ]);

      expect(summary.matched).toBe(1);
    });

    it('should skip zero-amount receipts', () => {
      insertReceipt(store, { totalAmount: 0 });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -500, date: '2025-01-15' },
      ]);

      expect(summary.matched).toBe(0);
    });

    it('should skip zero-amount transactions', () => {
      insertReceipt(store, { totalAmount: 500 });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: 0, date: '2025-01-15' },
      ]);

      expect(summary.matched).toBe(0);
      expect(summary.unmatched).toBe(1);
    });

    it('should skip transactions that already have a match', () => {
      const receiptId1 = insertReceipt(store, { externalId: '1', totalAmount: 1000 });
      insertReceipt(store, { externalId: '2', totalAmount: 1000 });

      // Pre-create a match for tx-1
      store.createMatch('tx-1', receiptId1, 'exact');

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -1000, date: '2025-01-15' },
      ]);

      // tx-1 already matched, and receipt-1 is already matched too
      // Only receipt-2 is unmatched, but tx-1 is unavailable
      expect(summary.matched).toBe(0);
    });

    it('should resolve conflicts: best-scoring receipt wins when multiple claim same transaction', () => {
      insertReceipt(store, {
        externalId: '1',
        totalAmount: 2000,
        date: '2025-01-15',
        vendorName: 'Target',
      });
      insertReceipt(store, {
        externalId: '2',
        totalAmount: 2000,
        date: '2025-01-20',
        vendorName: 'Other Store',
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -2000, date: '2025-01-15', payee: 'Target' },
      ]);

      // Receipt 1 matches with exact (amount + date + vendor)
      // Receipt 2 matches with possible (amount only, date outside 1 day, no vendor)
      // Receipt 1 wins
      expect(summary.matched).toBe(1);
      expect(summary.exact).toBe(1);
    });

    it('should match vendor with business suffix stripping', () => {
      insertReceipt(store, {
        totalAmount: 1500,
        date: '2025-01-15',
        vendorName: 'Acme Inc.',
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -1500, date: '2025-01-15', payee: 'Acme' },
      ]);

      expect(summary.exact).toBe(1);
    });

    it('should match vendor case-insensitively', () => {
      insertReceipt(store, {
        totalAmount: 1500,
        date: '2025-01-15',
        vendorName: 'STARBUCKS',
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -1500, date: '2025-01-15', payee: 'starbucks' },
      ]);

      expect(summary.exact).toBe(1);
    });

    it('should match vendor via imported_payee', () => {
      insertReceipt(store, {
        totalAmount: 1500,
        date: '2025-01-15',
        vendorName: 'Walmart',
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -1500, date: '2025-01-15', imported_payee: 'WALMART SUPERCENTER' },
      ]);

      // bidirectional substring: "walmart" is in "walmart supercenter"
      expect(summary.exact).toBe(1);
    });

    it('should handle YYYYMMDD integer dates from Actual Budget', () => {
      insertReceipt(store, {
        totalAmount: 864,
        date: '2025-11-06',
        vendorName: "Arby's",
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -864, date: 20251106, payee: 'Arbys 1569 - Farmington Nm' },
      ]);

      // date: 20251106 → 2025-11-06 (same day), vendor: "arbys" in "arbys 1569..."
      expect(summary.exact).toBe(1);
    });

    it('should strip apostrophes and punctuation for vendor matching', () => {
      insertReceipt(store, {
        totalAmount: 6490,
        date: '2025-04-08',
        vendorName: "Dick's Sporting Goods",
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -6490, date: '2025-04-08', payee: 'DICKS SPORTING GOODS12 - FARMINGTON NM' },
      ]);

      // "dicks sporting goods" is in "dicks sporting goods12 farmington nm"
      expect(summary.exact).toBe(1);
    });

    it('should return Infinity for unparseable dates (no false matches)', () => {
      insertReceipt(store, {
        totalAmount: 500,
        date: '2025-01-15',
        vendorName: 'Store',
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -500, date: 'invalid-date', payee: 'Store' },
      ]);

      // Date is unparseable → Infinity days → date signal fails → probable (amount + vendor)
      expect(summary.probable).toBe(1);
    });

    it('should flag matches to already-categorized transactions as overridesExisting', () => {
      insertReceipt(store, {
        totalAmount: 1500,
        date: '2025-01-15',
        vendorName: 'Target',
      });

      const service = new MatchingService(store, 5, 1, true);
      service.matchAll([
        { id: 'tx-1', amount: -1500, date: '2025-01-15', payee: 'Target', hasCategory: true },
      ]);

      const match = store.getMatchForTransaction('tx-1');
      expect(match).not.toBeNull();
      expect(match!.overridesExisting).toBe(1);
    });

    it('should not flag matches to uncategorized transactions as overridesExisting', () => {
      insertReceipt(store, {
        totalAmount: 1500,
        date: '2025-01-15',
        vendorName: 'Target',
      });

      const service = new MatchingService(store, 5, 1, true);
      service.matchAll([
        { id: 'tx-1', amount: -1500, date: '2025-01-15', payee: 'Target', hasCategory: false },
      ]);

      const match = store.getMatchForTransaction('tx-1');
      expect(match).not.toBeNull();
      expect(match!.overridesExisting).toBe(0);
    });

    it('should record match history', () => {
      const receiptId = insertReceipt(store, { totalAmount: 1000 });

      const service = new MatchingService(store, 5, 1, true);
      service.matchAll([
        { id: 'tx-1', amount: -1000, date: '2025-01-15' },
      ]);

      const history = store.getMatchHistory(receiptId);
      expect(history).toHaveLength(1);
      expect(history[0].action).toBe('match');
      expect(history[0].newTransactionId).toBe('tx-1');
    });

    it('should handle multiple receipts matching multiple transactions', () => {
      insertReceipt(store, { externalId: '1', totalAmount: 1000, date: '2025-01-10', vendorName: 'Store A' });
      insertReceipt(store, { externalId: '2', totalAmount: 2000, date: '2025-01-12', vendorName: 'Store B' });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -1000, date: '2025-01-10', payee: 'Store A' },
        { id: 'tx-2', amount: -2000, date: '2025-01-12', payee: 'Store B' },
      ]);

      expect(summary.matched).toBe(2);
      expect(summary.exact).toBe(2);
      expect(summary.unmatched).toBe(0);
    });
  });

  describe('unmatch', () => {
    it('should delete match and classifications', () => {
      const receiptId = insertReceipt(store, { totalAmount: 1000 });
      const matchId = store.createMatch('tx-1', receiptId, 'exact');

      // Add a classification
      store.insertLineItemClassification({
        receiptMatchId: matchId,
        lineItemIndex: 0,
        description: 'Item 1',
        unitPrice: 1000,
        totalPrice: 1000,
        amountWithTax: 1000,
      });

      const service = new MatchingService(store, 5, 1, true);
      service.unmatch(matchId);

      expect(store.getMatch(matchId)).toBeUndefined();
      expect(store.getClassificationsForMatch(matchId)).toHaveLength(0);
    });

    it('should record unmatch history', () => {
      const receiptId = insertReceipt(store, { totalAmount: 1000 });
      const matchId = store.createMatch('tx-1', receiptId, 'exact');

      const service = new MatchingService(store, 5, 1, true);
      service.unmatch(matchId);

      const history = store.getMatchHistory(receiptId);
      const unmatchEntry = history.find((h) => h.action === 'unmatch');
      expect(unmatchEntry).toBeDefined();
      expect(unmatchEntry!.oldTransactionId).toBe('tx-1');
    });

    it('should throw when match not found', () => {
      const service = new MatchingService(store, 5, 1, true);
      expect(() => service.unmatch('nonexistent')).toThrow('Match not found');
    });

    it('should throw when match is applied with snapshot', () => {
      const receiptId = insertReceipt(store, { totalAmount: 1000 });
      const matchId = store.createMatch('tx-1', receiptId, 'exact');
      store.updateMatchStatus(matchId, 'applied');
      store.setPreSplitSnapshot(matchId, JSON.stringify({ id: 'tx-1', amount: -1000 }));

      const service = new MatchingService(store, 5, 1, true);
      expect(() => service.unmatch(matchId)).toThrow('Rollback the split first');
    });

    it('should allow unmatch on applied match without snapshot (kept)', () => {
      const receiptId = insertReceipt(store, { totalAmount: 1000 });
      const matchId = store.createMatch('tx-1', receiptId, 'exact');
      store.updateMatchStatus(matchId, 'applied');

      const service = new MatchingService(store, 5, 1, true);
      expect(() => service.unmatch(matchId)).not.toThrow();
      expect(store.getMatch(matchId)).toBeUndefined();
    });
  });

  describe('rematch', () => {
    it('should create new match with manual confidence', () => {
      const receiptId = insertReceipt(store, { totalAmount: 1000 });
      const matchId = store.createMatch('tx-1', receiptId, 'exact');

      const service = new MatchingService(store, 5, 1, true);
      const newMatchId = service.rematch(matchId, 'tx-2');

      const newMatch = store.getMatch(newMatchId);
      expect(newMatch).toBeDefined();
      expect(newMatch!.transactionId).toBe('tx-2');
      expect(newMatch!.matchConfidence).toBe('manual');
      expect(newMatch!.receiptId).toBe(receiptId);
    });

    it('should delete old match and classifications', () => {
      const receiptId = insertReceipt(store, { totalAmount: 1000 });
      const matchId = store.createMatch('tx-1', receiptId, 'exact');
      store.insertLineItemClassification({
        receiptMatchId: matchId,
        lineItemIndex: 0,
        description: 'Item',
        unitPrice: 1000,
        totalPrice: 1000,
        amountWithTax: 1000,
      });

      const service = new MatchingService(store, 5, 1, true);
      service.rematch(matchId, 'tx-2');

      expect(store.getMatch(matchId)).toBeUndefined();
      expect(store.getClassificationsForMatch(matchId)).toHaveLength(0);
    });

    it('should record rematch history', () => {
      const receiptId = insertReceipt(store, { totalAmount: 1000 });
      const matchId = store.createMatch('tx-1', receiptId, 'exact');

      const service = new MatchingService(store, 5, 1, true);
      service.rematch(matchId, 'tx-2');

      const history = store.getMatchHistory(receiptId);
      const rematchEntry = history.find((h) => h.action === 'rematch');
      expect(rematchEntry).toBeDefined();
      expect(rematchEntry!.oldTransactionId).toBe('tx-1');
      expect(rematchEntry!.newTransactionId).toBe('tx-2');
      expect(rematchEntry!.newMatchConfidence).toBe('manual');
    });

    it('should throw when match not found', () => {
      const service = new MatchingService(store, 5, 1, true);
      expect(() => service.rematch('nonexistent', 'tx-2')).toThrow('Match not found');
    });

    it('should throw when match is applied', () => {
      const receiptId = insertReceipt(store, { totalAmount: 1000 });
      const matchId = store.createMatch('tx-1', receiptId, 'exact');
      store.updateMatchStatus(matchId, 'applied');

      const service = new MatchingService(store, 5, 1, true);
      expect(() => service.rematch(matchId, 'tx-2')).toThrow('Rollback the split first');
    });
  });
});
