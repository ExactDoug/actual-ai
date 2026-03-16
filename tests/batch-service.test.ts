import Database from 'better-sqlite3';
import crypto from 'crypto';
import BatchService from '../src/receipt/batch-service';
import ReceiptStore from '../src/receipt/receipt-store';
import MatchingService from '../src/receipt/matching-service';

// Minimal stubs for services that BatchService calls but we don't exercise fully
const mockClassifier = {
  classifyReceipt: jest.fn().mockResolvedValue(undefined),
};

const mockSplitService = {
  applySplit: jest.fn().mockResolvedValue(undefined),
};

let store: ReceiptStore;
let matchingService: MatchingService;
let batchService: BatchService;

function insertReceiptAndMatch(
  overrides: {
    vendorName?: string;
    date?: string;
    totalAmount?: number;
    status?: string;
    confidence?: string;
    overridesExisting?: boolean;
  } = {},
): { receiptId: string; matchId: string } {
  const receiptId = crypto.randomUUID();
  const matchId = crypto.randomUUID();
  const txId = crypto.randomUUID();

  // Insert directly via the store's internal DB by using upsertReceipt + createMatch
  store.upsertReceipt({
    externalId: receiptId,
    providerId: 'test',
    vendorName: overrides.vendorName ?? 'Test Store',
    totalAmount: overrides.totalAmount ?? 1000,
    date: overrides.date ?? '2026-01-15',
    currency: 'USD',
    lineItemCount: 2,
    taxAmount: 50,
    receiptData: JSON.stringify({ lineItems: [] }),
    fetchedAt: new Date().toISOString(),
  });

  // Get the actual receipt ID from the store
  const receipt = store.getReceiptByExternalId('test', receiptId);
  const actualReceiptId = receipt!.id as string;

  const actualMatchId = store.createMatch(txId, actualReceiptId, overrides.confidence ?? 'exact', overrides.overridesExisting ?? false);

  if (overrides.status && overrides.status !== 'pending') {
    store.updateMatchStatus(actualMatchId, overrides.status);
  }

  return { receiptId: actualReceiptId, matchId: actualMatchId };
}

beforeEach(() => {
  // Use in-memory directory with unique path to avoid conflicts
  const tmpDir = `/tmp/actual-ai-test-batch-${crypto.randomUUID()}/`;
  require('fs').mkdirSync(tmpDir, { recursive: true });
  store = new ReceiptStore(tmpDir);
  matchingService = new MatchingService(store, 5, 1, true);
  batchService = new BatchService(
    store,
    mockClassifier as any,
    mockSplitService as any,
    matchingService,
  );
  jest.clearAllMocks();
});

afterEach(() => {
  store.close();
});

describe('BatchService', () => {
  describe('resolveMatchIds', () => {
    it('should resolve explicit matchIds', async () => {
      const { matchId: m1 } = insertReceiptAndMatch({ status: 'pending' });
      const { matchId: m2 } = insertReceiptAndMatch({ status: 'pending' });

      const result = await batchService.batchClassify(
        { matchIds: [m1, m2] },
        [], [], [],
      );

      expect(result.processed).toBe(2);
      expect(mockClassifier.classifyReceipt).toHaveBeenCalledTimes(2);
    });

    it('should resolve filter-based selection', async () => {
      insertReceiptAndMatch({ status: 'pending', confidence: 'exact' });
      insertReceiptAndMatch({ status: 'pending', confidence: 'probable' });
      insertReceiptAndMatch({ status: 'classified', confidence: 'exact' });

      const result = await batchService.batchClassify(
        { filter: { status: 'pending' } },
        [], [], [],
      );

      expect(result.processed).toBe(2);
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        insertReceiptAndMatch({ status: 'pending' });
      }

      const result = await batchService.batchClassify(
        { filter: { status: 'pending' }, limit: 2 },
        [], [], [],
      );

      expect(result.processed).toBe(2);
    });

    it('should return empty result when no matches found', async () => {
      const result = await batchService.batchClassify(
        { filter: { status: 'pending' } },
        [], [], [],
      );

      expect(result.processed).toBe(0);
      expect(result.succeeded).toBe(0);
    });
  });

  describe('batchApprove', () => {
    it('should approve all line items and update match status', () => {
      const { matchId } = insertReceiptAndMatch({ status: 'classified' });

      // Insert a line item classification
      store.insertLineItemClassification({
        receiptMatchId: matchId,
        lineItemIndex: 0,
        description: 'Test Item',
        unitPrice: 500,
        totalPrice: 500,
        amountWithTax: 525,
      });

      const result = batchService.batchApprove({ matchIds: [matchId] });

      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);

      const match = store.getMatch(matchId);
      expect(match!.status).toBe('approved');

      const classifications = store.getClassificationsForMatch(matchId);
      expect(classifications[0].status).toBe('approved');
    });

    it('should fail for matches not in classified status', () => {
      const { matchId } = insertReceiptAndMatch({ status: 'pending' });

      const result = batchService.batchApprove({ matchIds: [matchId] });

      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toContain('pending');
    });
  });

  describe('batchReject', () => {
    it('should reject matches and their line items', () => {
      const { matchId } = insertReceiptAndMatch({ status: 'classified' });

      store.insertLineItemClassification({
        receiptMatchId: matchId,
        lineItemIndex: 0,
        description: 'Test Item',
        unitPrice: 500,
        totalPrice: 500,
        amountWithTax: 525,
      });

      const result = batchService.batchReject({ matchIds: [matchId] });

      expect(result.succeeded).toBe(1);
      const match = store.getMatch(matchId);
      expect(match!.status).toBe('rejected');
    });

    it('should not reject applied matches', () => {
      const { matchId } = insertReceiptAndMatch({ status: 'applied' });

      const result = batchService.batchReject({ matchIds: [matchId] });

      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toContain('rollback');
    });
  });

  describe('batchApply', () => {
    it('should call splitService for each match', async () => {
      const { matchId: m1 } = insertReceiptAndMatch({ status: 'approved' });
      const { matchId: m2 } = insertReceiptAndMatch({ status: 'approved' });

      const result = await batchService.batchApply({ matchIds: [m1, m2] });

      expect(result.processed).toBe(2);
      expect(mockSplitService.applySplit).toHaveBeenCalledTimes(2);
    });

    it('should collect errors without aborting the batch', async () => {
      const { matchId: m1 } = insertReceiptAndMatch({ status: 'approved' });
      const { matchId: m2 } = insertReceiptAndMatch({ status: 'approved' });

      mockSplitService.applySplit
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Split failed'));

      const result = await batchService.batchApply({ matchIds: [m1, m2] });

      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toBe('Split failed');
    });
  });

  describe('batchUnmatch', () => {
    it('should unmatch multiple matches', () => {
      const { matchId: m1 } = insertReceiptAndMatch({ status: 'pending' });
      const { matchId: m2 } = insertReceiptAndMatch({ status: 'classified' });

      const result = batchService.batchUnmatch({ matchIds: [m1, m2] });

      expect(result.succeeded).toBe(2);
      expect(store.getMatch(m1)).toBeUndefined();
      expect(store.getMatch(m2)).toBeUndefined();
    });
  });

  describe('filter resolution', () => {
    it('should filter by vendor substring', async () => {
      insertReceiptAndMatch({ status: 'pending', vendorName: 'Albertsons #123' });
      insertReceiptAndMatch({ status: 'pending', vendorName: 'Dollar Tree' });

      const result = await batchService.batchClassify(
        { filter: { vendor: 'Albert' } },
        [], [], [],
      );

      expect(result.processed).toBe(1);
    });

    it('should filter by date range', async () => {
      insertReceiptAndMatch({ status: 'pending', date: '2026-01-10' });
      insertReceiptAndMatch({ status: 'pending', date: '2026-01-20' });
      insertReceiptAndMatch({ status: 'pending', date: '2026-02-01' });

      const result = await batchService.batchClassify(
        { filter: { dateFrom: '2026-01-15', dateTo: '2026-01-25' } },
        [], [], [],
      );

      expect(result.processed).toBe(1);
    });

    it('should filter by amount range', async () => {
      insertReceiptAndMatch({ status: 'pending', totalAmount: 500 });
      insertReceiptAndMatch({ status: 'pending', totalAmount: 1500 });
      insertReceiptAndMatch({ status: 'pending', totalAmount: 3000 });

      const result = await batchService.batchClassify(
        { filter: { amountMin: 1000, amountMax: 2000 } },
        [], [], [],
      );

      expect(result.processed).toBe(1);
    });

    it('should filter by overridesExisting', async () => {
      insertReceiptAndMatch({ status: 'pending', overridesExisting: true });
      insertReceiptAndMatch({ status: 'pending', overridesExisting: false });

      const result = await batchService.batchClassify(
        { filter: { overridesExisting: true } },
        [], [], [],
      );

      expect(result.processed).toBe(1);
    });

    it('should filter by multiple statuses', async () => {
      insertReceiptAndMatch({ status: 'pending' });
      insertReceiptAndMatch({ status: 'classified' });
      insertReceiptAndMatch({ status: 'approved' });

      const result = await batchService.batchClassify(
        { filter: { status: ['pending', 'classified'] } },
        [], [], [],
      );

      expect(result.processed).toBe(2);
    });
  });
});
