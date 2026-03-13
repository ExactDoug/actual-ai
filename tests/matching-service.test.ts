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

      // Phase 3 fuzzy match: amount exact (0.50) + date same day (0.30) + vendor 0 (0.0) = 0.80
      // Date within structural tolerance (3 days) → probable
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

      // Phase 3 fuzzy: amount exact + date 4 days (0.50 score) + vendor match (0.85+)
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

      // Phase 3 fuzzy: amount exact (0.50) + date 9 days (~0.50 * 0.30 = 0.15) + no vendor = 0.65
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

      // Receipt 1 matches with exact (amount + date + vendor) in Phase 1
      // Receipt 2 cannot match in Phase 1 (date too far, vendor mismatch)
      // tx-1 is consumed, so receipt 2 stays unmatched
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

      // Date is unparseable → Infinity days → hard date cap blocks in Phase 3
      // But vendor matches, so it should still match if within maxDateGapDays...
      // Actually Infinity > 30 (maxDateGapDays), so it's blocked entirely
      expect(summary.matched).toBe(0);
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

    // === New tests for the redesigned algorithm ===

    it('should match all 5 same-vendor same-amount receipts via Phase 2 structural matching (daily Arbys)', () => {
      // 5 Arby's receipts Mon-Fri, all $8.64
      insertReceipt(store, { externalId: 'r-mon', totalAmount: 864, date: '2025-03-03', vendorName: "Arby's" });
      insertReceipt(store, { externalId: 'r-tue', totalAmount: 864, date: '2025-03-04', vendorName: "Arby's" });
      insertReceipt(store, { externalId: 'r-wed', totalAmount: 864, date: '2025-03-05', vendorName: "Arby's" });
      insertReceipt(store, { externalId: 'r-thu', totalAmount: 864, date: '2025-03-06', vendorName: "Arby's" });
      insertReceipt(store, { externalId: 'r-fri', totalAmount: 864, date: '2025-03-07', vendorName: "Arby's" });

      // 5 bank transactions Tue-Sat (posted next day), all $8.64
      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-tue', amount: -864, date: '2025-03-04', payee: 'Arbys 1569 - Farmington Nm' },
        { id: 'tx-wed', amount: -864, date: '2025-03-05', payee: 'Arbys 1569 - Farmington Nm' },
        { id: 'tx-thu', amount: -864, date: '2025-03-06', payee: 'Arbys 1569 - Farmington Nm' },
        { id: 'tx-fri', amount: -864, date: '2025-03-07', payee: 'Arbys 1569 - Farmington Nm' },
        { id: 'tx-sat', amount: -864, date: '2025-03-08', payee: 'Arbys 1569 - Farmington Nm' },
      ]);

      // All 5 should match (not just 1 like the old algorithm)
      expect(summary.matched).toBe(5);
      expect(summary.unmatched).toBe(0);
    });

    it('should match daily receipts to correct chronological transactions', () => {
      // Receipt Mon matches tx-Tue (next day), not some random tx
      insertReceipt(store, { externalId: 'r-mon', totalAmount: 864, date: '2025-03-03', vendorName: "Arby's" });
      insertReceipt(store, { externalId: 'r-tue', totalAmount: 864, date: '2025-03-04', vendorName: "Arby's" });

      const service = new MatchingService(store, 5, 1, true);
      service.matchAll([
        { id: 'tx-tue', amount: -864, date: '2025-03-04', payee: 'Arbys 1569' },
        { id: 'tx-wed', amount: -864, date: '2025-03-05', payee: 'Arbys 1569' },
      ]);

      // r-mon (03-03) should match tx-tue (03-04) — closest chronologically
      // r-tue (03-04) should match tx-wed (03-05) — next available
      const rMonId = store.getUnmatchedReceipts().find((r) => r.externalId === 'r-mon');
      expect(rMonId).toBeUndefined(); // both should be matched (not in unmatched list)

      const { total } = store.listMatchQueue({});
      expect(total).toBe(2);
    });

    it('should reject matches beyond hard date cap (30 days)', () => {
      insertReceipt(store, {
        totalAmount: 2500,
        date: '2023-06-15',
        vendorName: 'Coffee Shop',
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -2500, date: '2025-01-15', payee: 'Coffee Shop' },
      ]);

      // Receipt from 2023, transaction from 2025 — beyond 30 day cap
      expect(summary.matched).toBe(0);
      expect(summary.unmatched).toBe(1);
    });

    it('should report phase breakdown in summary', () => {
      // Phase 1: exact match
      insertReceipt(store, { externalId: '1', totalAmount: 1000, date: '2025-01-10', vendorName: 'Store A' });
      // Phase 3: fuzzy (amount only, date close but no vendor)
      insertReceipt(store, { externalId: '2', totalAmount: 2000, date: '2025-01-12', vendorName: 'Unknown' });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -1000, date: '2025-01-10', payee: 'Store A' },
        { id: 'tx-2', amount: -2000, date: '2025-01-12', payee: 'Different Store' },
      ]);

      expect(summary.matched).toBe(2);
      expect(summary.phase1Matched).toBe(1); // Store A exact match
      expect(summary.phase1Matched + summary.phase2Matched + summary.phase3Matched).toBe(2);
    });

    it('should handle deterministic output for identical inputs', () => {
      insertReceipt(store, { externalId: '1', totalAmount: 1000, date: '2025-01-10', vendorName: 'Store A' });
      insertReceipt(store, { externalId: '2', totalAmount: 2000, date: '2025-01-12', vendorName: 'Store B' });

      const transactions = [
        { id: 'tx-1', amount: -1000, date: '2025-01-10', payee: 'Store A' },
        { id: 'tx-2', amount: -2000, date: '2025-01-12', payee: 'Store B' },
      ];

      // Run twice with different stores but same data
      const service1 = new MatchingService(store, 5, 1, true);
      const summary1 = service1.matchAll(transactions);

      // Create a second store with the same data
      const { store: store2, dir: dir2 } = createTempStore();
      insertReceipt(store2, { externalId: '1', totalAmount: 1000, date: '2025-01-10', vendorName: 'Store A' });
      insertReceipt(store2, { externalId: '2', totalAmount: 2000, date: '2025-01-12', vendorName: 'Store B' });
      const service2 = new MatchingService(store2, 5, 1, true);
      const summary2 = service2.matchAll(transactions);

      expect(summary1.matched).toBe(summary2.matched);
      expect(summary1.exact).toBe(summary2.exact);
      expect(summary1.phase1Matched).toBe(summary2.phase1Matched);

      store2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('should not match receipts 31+ days apart even with same vendor and amount', () => {
      insertReceipt(store, {
        totalAmount: 864,
        date: '2025-01-01',
        vendorName: "Arby's",
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -864, date: '2025-02-05', payee: 'Arbys 1569' },
      ]);

      // 35 days apart — exceeds maxDateGapDays (30)
      expect(summary.matched).toBe(0);
    });

    it('Phase 2 should not activate for single-receipt vendor groups', () => {
      // Only 1 Arby's receipt — should go to Phase 1 or Phase 3, not Phase 2
      insertReceipt(store, { externalId: '1', totalAmount: 864, date: '2025-03-03', vendorName: "Arby's" });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -864, date: '2025-03-03', payee: 'Arbys 1569' },
      ]);

      expect(summary.matched).toBe(1);
      expect(summary.phase1Matched).toBe(1);
      expect(summary.phase2Matched).toBe(0);
    });

    it('Phase 1 should consume matches before Phase 2 sees them', () => {
      // Two different vendors, same amount — Phase 1 should grab exact matches first
      insertReceipt(store, { externalId: '1', totalAmount: 1000, date: '2025-03-03', vendorName: 'Store A' });
      insertReceipt(store, { externalId: '2', totalAmount: 1000, date: '2025-03-04', vendorName: 'Store B' });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        { id: 'tx-1', amount: -1000, date: '2025-03-03', payee: 'Store A' },
        { id: 'tx-2', amount: -1000, date: '2025-03-04', payee: 'Store B' },
      ]);

      expect(summary.matched).toBe(2);
      expect(summary.phase1Matched).toBe(2); // Both exact
      expect(summary.phase2Matched).toBe(0); // Nothing left for Phase 2
    });

    it('should use Jaro-Winkler fuzzy matching for OCR typos in Phase 3', () => {
      insertReceipt(store, {
        totalAmount: 3500,
        date: '2025-03-10',
        vendorName: 'Fast Freddys Auto Repair',
      });

      const service = new MatchingService(store, 5, 1, true);
      const summary = service.matchAll([
        // OCR typo: "Repatr" instead of "Repair"
        { id: 'tx-1', amount: -3500, date: '2025-03-10', payee: 'Fast Freddys Auto Repatr' },
      ]);

      // Phase 1 fails (vendor substring match fails due to typo)
      // Phase 3 should catch it via Jaro-Winkler fuzzy matching
      expect(summary.matched).toBe(1);
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
