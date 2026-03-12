import Database from 'better-sqlite3';
import crypto from 'crypto';
import ReceiptStore from '../src/receipt/receipt-store';
import {
  renderReceiptQueue, renderReceiptDetail, renderUnmatchedReceipts,
  renderReceiptDashboard,
} from '../src/web/views/receipt-renderer';

let store: ReceiptStore;
let tmpDir: string;

function insertReceiptAndMatch(overrides: {
  vendorName?: string;
  date?: string;
  totalAmount?: number;
  status?: string;
  confidence?: string;
  overridesExisting?: boolean;
  lineItemCount?: number;
} = {}): { receiptId: string; matchId: string } {
  const externalId = crypto.randomUUID();
  const txId = crypto.randomUUID();

  store.upsertReceipt({
    externalId,
    providerId: 'test',
    vendorName: overrides.vendorName ?? 'Test Store',
    totalAmount: overrides.totalAmount ?? 1000,
    date: overrides.date ?? '2026-01-15',
    currency: 'USD',
    lineItemCount: overrides.lineItemCount ?? 2,
    taxAmount: 50,
    receiptData: JSON.stringify({ lineItems: [{ description: 'Item 1', total: 500 }, { description: 'Item 2', total: 500 }] }),
    fetchedAt: new Date().toISOString(),
  });

  const receipt = store.getReceiptByExternalId('test', externalId);
  const receiptId = receipt!.id as string;
  const matchId = store.createMatch(txId, receiptId, overrides.confidence ?? 'exact', overrides.overridesExisting ?? false);

  if (overrides.status && overrides.status !== 'pending') {
    store.updateMatchStatus(matchId, overrides.status);
  }

  return { receiptId, matchId };
}

beforeEach(() => {
  tmpDir = `/tmp/actual-ai-test-views-${crypto.randomUUID()}/`;
  require('fs').mkdirSync(tmpDir, { recursive: true });
  store = new ReceiptStore(tmpDir);
});

afterEach(() => {
  store.close();
});

describe('ReceiptStore - listMatchQueue', () => {
  it('should return paginated results with receipt data', () => {
    for (let i = 0; i < 5; i++) {
      insertReceiptAndMatch({ vendorName: `Store ${i}` });
    }

    const result = store.listMatchQueue({ page: 1, limit: 3 });
    expect(result.total).toBe(5);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toHaveProperty('vendorName');
    expect(result.rows[0]).toHaveProperty('receiptDate');
    expect(result.rows[0]).toHaveProperty('matchConfidence');
  });

  it('should filter by status', () => {
    insertReceiptAndMatch({ status: 'pending' });
    insertReceiptAndMatch({ status: 'classified' });
    insertReceiptAndMatch({ status: 'approved' });

    const result = store.listMatchQueue({ status: 'pending' });
    expect(result.total).toBe(1);
    expect(result.rows[0].status).toBe('pending');
  });

  it('should filter by confidence', () => {
    insertReceiptAndMatch({ confidence: 'exact' });
    insertReceiptAndMatch({ confidence: 'probable' });

    const result = store.listMatchQueue({ confidence: 'exact' });
    expect(result.total).toBe(1);
    expect(result.rows[0].matchConfidence).toBe('exact');
  });

  it('should filter by vendor substring', () => {
    insertReceiptAndMatch({ vendorName: 'Albertsons #123' });
    insertReceiptAndMatch({ vendorName: 'Dollar Tree' });

    const result = store.listMatchQueue({ vendor: 'Albert' });
    expect(result.total).toBe(1);
  });

  it('should filter by date range', () => {
    insertReceiptAndMatch({ date: '2026-01-10' });
    insertReceiptAndMatch({ date: '2026-01-20' });
    insertReceiptAndMatch({ date: '2026-02-01' });

    const result = store.listMatchQueue({ dateFrom: '2026-01-15', dateTo: '2026-01-25' });
    expect(result.total).toBe(1);
  });

  it('should filter by overridesExisting', () => {
    insertReceiptAndMatch({ overridesExisting: true });
    insertReceiptAndMatch({ overridesExisting: false });

    const result = store.listMatchQueue({ overridesExisting: true });
    expect(result.total).toBe(1);
  });

  it('should sort by vendor ascending', () => {
    insertReceiptAndMatch({ vendorName: 'Zebra' });
    insertReceiptAndMatch({ vendorName: 'Apple' });

    const result = store.listMatchQueue({ sortBy: 'vendor', sortDir: 'asc' });
    expect(result.rows[0].vendorName).toBe('Apple');
    expect(result.rows[1].vendorName).toBe('Zebra');
  });

  it('should sort by amount descending', () => {
    insertReceiptAndMatch({ totalAmount: 500 });
    insertReceiptAndMatch({ totalAmount: 2000 });

    const result = store.listMatchQueue({ sortBy: 'amount', sortDir: 'desc' });
    expect(result.rows[0].totalAmount).toBe(2000);
    expect(result.rows[1].totalAmount).toBe(500);
  });
});

describe('ReceiptStore - getMatchDetail', () => {
  it('should return combined match, receipt, classifications, and history', () => {
    const { receiptId, matchId } = insertReceiptAndMatch({ status: 'classified' });

    store.insertLineItemClassification({
      receiptMatchId: matchId,
      lineItemIndex: 0,
      description: 'Test Item',
      unitPrice: 500,
      totalPrice: 500,
      amountWithTax: 525,
      suggestedCategoryId: 'cat-1',
      suggestedCategoryName: 'Groceries',
      confidence: 'high',
    });

    store.insertMatchHistory({
      receiptId,
      newTransactionId: 'tx-1',
      action: 'match',
      newMatchConfidence: 'exact',
    });

    const detail = store.getMatchDetail(matchId);
    expect(detail).not.toBeNull();
    expect(detail!.match.status).toBe('classified');
    expect(detail!.receipt.vendorName).toBe('Test Store');
    expect(detail!.classifications).toHaveLength(1);
    expect(detail!.classifications[0].suggestedCategoryName).toBe('Groceries');
    expect(detail!.history).toHaveLength(1);
  });

  it('should return null for nonexistent match', () => {
    expect(store.getMatchDetail('nonexistent')).toBeNull();
  });
});

describe('Receipt view renderers', () => {
  it('renderReceiptQueue should produce valid HTML', () => {
    const rows = [{
      id: 'match-1',
      transactionId: 'tx-1',
      receiptId: 'rec-1',
      matchConfidence: 'exact',
      matchedAt: '2026-01-15T10:00:00Z',
      status: 'pending',
      overridesExisting: 0,
      vendorName: 'Test Store',
      totalAmount: 1000,
      receiptDate: '2026-01-15',
      lineItemCount: 2,
      currency: 'USD',
    }];

    const html = renderReceiptQueue(rows, 1, {});
    expect(html).toContain('Receipt Match Queue');
    expect(html).toContain('Test Store');
    expect(html).toContain('$10.00');
    expect(html).toContain('badge pending');
    expect(html).toContain('badge confidence-exact');
  });

  it('renderReceiptQueue should show empty state', () => {
    const html = renderReceiptQueue([], 0, {});
    expect(html).toContain('No receipt matches found');
  });

  it('renderReceiptDetail should show receipt and match details', () => {
    const match = {
      id: 'match-1',
      transactionId: 'tx-1',
      receiptId: 'rec-1',
      matchConfidence: 'exact',
      matchedAt: '2026-01-15T10:00:00Z',
      status: 'classified',
      overridesExisting: 0,
    };
    const receipt = {
      id: 'rec-1',
      vendorName: 'Walmart',
      date: '2026-01-15',
      totalAmount: 2500,
      taxAmount: 200,
      currency: 'USD',
      lineItemCount: 3,
      providerId: 'veryfi',
      receiptData: JSON.stringify({ lineItems: [] }),
    };
    const classifications = [{
      id: 'cls-1',
      receiptMatchId: 'match-1',
      lineItemIndex: 0,
      description: 'Bananas',
      quantity: 1,
      unitPrice: 200,
      totalPrice: 200,
      allocatedTax: 16,
      amountWithTax: 216,
      suggestedCategoryId: 'cat-1',
      suggestedCategoryName: 'Groceries',
      classificationType: 'existing',
      confidence: 'high',
      status: 'pending',
    }];

    const html = renderReceiptDetail(match, receipt, classifications, []);
    expect(html).toContain('Walmart');
    expect(html).toContain('$25.00');
    expect(html).toContain('Bananas');
    expect(html).toContain('Groceries');
    expect(html).toContain('Split Preview');
  });

  it('renderReceiptDetail should show override warning', () => {
    const match = { id: 'm1', transactionId: 't1', receiptId: 'r1', matchConfidence: 'exact', matchedAt: '', status: 'pending', overridesExisting: 1 };
    const receipt = { id: 'r1', vendorName: 'Store', date: '', totalAmount: 0, taxAmount: 0, currency: 'USD', lineItemCount: 0, providerId: 'test', receiptData: '{}' };

    const html = renderReceiptDetail(match, receipt, [], []);
    expect(html).toContain('already has a category');
    expect(html).toContain('Override');
  });

  it('renderUnmatchedReceipts should list receipts', () => {
    const rows = [{
      id: 'r1', vendorName: 'Target', date: '2026-01-10', totalAmount: 3000,
      lineItemCount: 5, providerId: 'veryfi', fetchedAt: '2026-01-10T10:00:00Z',
    }];
    const html = renderUnmatchedReceipts(rows);
    expect(html).toContain('Unmatched Receipts');
    expect(html).toContain('Target');
    expect(html).toContain('$30.00');
  });

  it('renderReceiptDashboard should show stats', () => {
    const stats = {
      totalReceipts: 100, totalMatched: 80, pending: 20,
      classified: 30, approved: 15, applied: 10,
      rejected: 5, totalUnmatched: 20,
    };
    const html = renderReceiptDashboard(stats);
    expect(html).toContain('Receipt Dashboard');
    expect(html).toContain('100');
    expect(html).toContain('80');
    expect(html).toContain('20');
  });
});
