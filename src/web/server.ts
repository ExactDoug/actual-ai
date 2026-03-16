import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import ClassificationStore, { ClassificationFilter } from './classification-store';
import { authMiddleware, loginHandler, loginPage, COOKIE_NAME } from './auth';
import { renderDashboard, renderClassifications, renderHistory } from './views/renderer';
import ReceiptStore from '../receipt/receipt-store';
import ConnectorRegistry from '../receipt/connector-registry';
import { reconcileMatchTax } from '../receipt/tax-reconciler';
import type { BatchRequest, BatchResponse } from '../receipt/batch-service';
import {
  renderReceiptQueue, renderReceiptDetail, renderUnmatchedReceipts,
  renderReceiptDashboard, MatchQueueFilter,
} from './views/receipt-renderer';

export interface WebServerDeps {
  actualPassword: string;
  classificationStore: ClassificationStore;
  onApply: (classifications: { id: string; transactionId: string; suggestedCategoryId: string; notes: string }[]) => Promise<{ applied: number; skipped: number }>;
  onTriggerClassify: () => Promise<void>;
  getCategories: () => Promise<{ id: string; name: string; group: string }[]>;
  getConfig: () => Record<string, unknown>;
  receiptStore?: ReceiptStore;
  connectorRegistry?: ConnectorRegistry;
  onReceiptFetch?: () => Promise<{ fetched: number; errors: Array<{ provider: string; message: string }> }>;
  onReceiptClassify?: (matchId: string) => Promise<void>;
  onReceiptApplySplit?: (matchId: string) => Promise<void>;
  onReceiptUnmatch?: (matchId: string) => void;
  onReceiptRematch?: (matchId: string, newTransactionId: string) => string;
  onReceiptRollback?: (matchId: string) => Promise<void>;
  onBatchClassify?: (request: BatchRequest) => Promise<BatchResponse>;
  onBatchApprove?: (request: BatchRequest) => BatchResponse;
  onBatchApply?: (request: BatchRequest) => Promise<BatchResponse>;
  onBatchUnmatch?: (request: BatchRequest) => BatchResponse;
  onBatchReject?: (request: BatchRequest) => BatchResponse;
  onBatchReclassify?: (request: BatchRequest) => Promise<BatchResponse>;
  getVeryfiProfiles?: () => Promise<Array<{
    username: string;
    companyName: string;
    accountId: number;
    isPrimary: boolean;
    type: string;
    displayType: string;
  }>>;
  onResetAndRematch?: () => Promise<{
    reset: number;
    preserved: number;
    resetErrors: Array<{ matchId: string; error: string }>;
    rematchSummary: { matched: number; exact: number; probable: number; possible: number; unmatched: number };
  }>;
  getTransactionDetails?: (transactionId: string) => Promise<{
    amount?: number;
    date?: string;
    payeeName?: string;
    importedPayee?: string;
    accountName?: string;
    categoryId?: string;
    categoryName?: string;
    isParent?: boolean;
    subtransactions?: { amount: number; categoryId?: string; categoryName?: string }[];
  } | null>;
  getTransactionsBulk?: (transactionIds: string[]) => Promise<Record<string, {
    amount?: number;
    date?: string;
    payeeName?: string;
    importedPayee?: string;
    accountName?: string;
    categoryId?: string;
    categoryName?: string;
    isParent?: boolean;
    subtransactions?: { amount: number; categoryId?: string; categoryName?: string }[];
  }>>;
}

export function createWebServer(deps: WebServerDeps): express.Express {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Public routes
  app.get('/login', (_req: Request, res: Response) => { res.send(loginPage()); });
  app.post('/login', loginHandler(deps.actualPassword));
  app.get('/logout', (_req: Request, res: Response) => { res.clearCookie(COOKIE_NAME); res.redirect('/login'); });

  // Protected routes
  app.use(authMiddleware);

  // --- Pages ---
  app.get('/', (_req: Request, res: Response) => {
    const stats = deps.classificationStore.getStats();
    const runs = deps.classificationStore.getRuns().slice(0, 10);
    res.send(renderDashboard(stats, runs));
  });

  app.get('/classifications', (req: Request, res: Response) => {
    const filter = parseFilter(req.query as Record<string, unknown>);
    const result = deps.classificationStore.list(filter);
    const accounts = deps.classificationStore.getDistinctAccounts();
    const categoryGroups = deps.classificationStore.getDistinctCategoryGroups();
    res.send(renderClassifications(result.rows, result.total, filter, accounts, categoryGroups));
  });

  app.get('/history', (_req: Request, res: Response) => {
    const runs = deps.classificationStore.getRuns();
    res.send(renderHistory(runs));
  });

  // --- API Routes ---
  app.get('/api/classifications', (req: Request, res: Response) => {
    const filter = parseFilter(req.query as Record<string, unknown>);
    const result = deps.classificationStore.list(filter);
    res.json({ rows: result.rows, total: result.total, page: filter.page ?? 1, limit: filter.limit ?? 50 });
  });

  app.get('/api/classifications/:id', (req: Request, res: Response) => {
    const record = deps.classificationStore.getById(req.params.id as string);
    if (!record) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(record);
  });

  app.patch('/api/classifications/:id', (req: Request, res: Response) => {
    const { status } = req.body as { status?: string };
    if (status !== 'approved' && status !== 'rejected') {
      res.status(400).json({ error: 'Status must be "approved" or "rejected"' });
      return;
    }
    const ok = deps.classificationStore.updateStatus(req.params.id as string, status);
    if (!ok) { res.status(404).json({ error: 'Not found or already applied' }); return; }
    res.json({ success: true });
  });

  app.post('/api/classifications/batch', (req: Request, res: Response) => {
    const { ids, status, filter } = req.body as { ids?: string[]; status?: string; filter?: ClassificationFilter };
    if (status !== 'approved' && status !== 'rejected') {
      res.status(400).json({ error: 'Status must be "approved" or "rejected"' });
      return;
    }
    let changed = 0;
    if (ids && ids.length > 0) {
      changed = deps.classificationStore.batchUpdateStatus(ids, status);
    } else if (filter) {
      changed = deps.classificationStore.batchUpdateByFilter(filter, status);
    } else {
      res.status(400).json({ error: 'Provide ids array or filter object' });
      return;
    }
    res.json({ success: true, changed });
  });

  app.post('/api/classifications/apply', async (_req: Request, res: Response) => {
    try {
      const approved = deps.classificationStore.getApproved();
      if (approved.length === 0) {
        res.json({ applied: 0, skipped: 0, message: 'No approved classifications to apply' });
        return;
      }

      const toApply = approved.map((c) => ({
        id: c.id,
        transactionId: c.transactionId,
        suggestedCategoryId: c.suggestedCategoryId,
        notes: c.notes ?? '',
      }));

      const result = await deps.onApply(toApply);
      res.json(result);
    } catch (error) {
      console.error('Error applying classifications:', error);
      res.status(500).json({ error: 'Failed to apply classifications' });
    }
  });

  app.get('/api/categories', async (_req: Request, res: Response) => {
    try {
      const categories = await deps.getCategories();
      res.json(categories);
    } catch (error) {
      console.error('Error fetching categories:', error);
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  });

  app.get('/api/runs', (_req: Request, res: Response) => {
    res.json(deps.classificationStore.getRuns());
  });

  app.get('/api/stats', (_req: Request, res: Response) => {
    res.json(deps.classificationStore.getStats());
  });

  app.post('/api/classify', async (_req: Request, res: Response) => {
    try {
      deps.onTriggerClassify();
      res.json({ message: 'Classification run started' });
    } catch (error) {
      console.error('Error triggering classification:', error);
      res.status(500).json({ error: 'Failed to start classification' });
    }
  });

  app.get('/api/config', (_req: Request, res: Response) => {
    res.json(deps.getConfig());
  });

  // --- Receipt Page Routes ---
  if (deps.receiptStore) {
    const receiptStore = deps.receiptStore;
    const connectorRegistry = deps.connectorRegistry;

    app.get('/receipts/dashboard', (_req: Request, res: Response) => {
      const stats = receiptStore.getStats();
      res.send(renderReceiptDashboard(stats));
    });

    app.get('/receipts/unmatched', (_req: Request, res: Response) => {
      const rows = receiptStore.getUnmatchedReceipts();
      res.send(renderUnmatchedReceipts(rows));
    });

    app.get('/receipts/:id', (req: Request, res: Response) => {
      const detail = receiptStore.getMatchDetail(req.params.id as string);
      if (!detail) {
        res.status(404).send('Match not found');
        return;
      }
      const html = renderReceiptDetail(
        detail.match, detail.receipt,
        detail.classifications, detail.history,
      );
      res.send(html);
    });

    app.get('/receipts', (req: Request, res: Response) => {
      const filter = parseMatchQueueFilter(req.query as Record<string, unknown>);
      let overridesExisting: boolean | undefined;
      if (filter.overridesExisting === '1') overridesExisting = true;
      else if (filter.overridesExisting === '0') overridesExisting = false;
      const storeFilter = { ...filter, overridesExisting };
      const result = receiptStore.listMatchQueue(storeFilter);
      res.send(renderReceiptQueue(result.rows, result.total, filter));
    });

    // --- Receipt API Routes ---

    app.get('/api/receipts/unmatched', (_req: Request, res: Response) => {
      const rows = receiptStore.getUnmatchedReceipts();
      res.json(rows);
    });

    app.get('/api/receipts/:id', (req: Request, res: Response) => {
      const receipt = receiptStore.getReceipt(req.params.id as string);
      if (!receipt) {
        res.status(404).json({ error: 'Receipt not found' });
        return;
      }
      res.json(receipt);
    });

    app.get('/api/receipts', (req: Request, res: Response) => {
      const filter = parseReceiptFilter(req.query as Record<string, unknown>);
      const result = receiptStore.listReceipts(filter);
      res.json({ rows: result.rows, total: result.total, page: filter.page ?? 1, limit: filter.limit ?? 50 });
    });

    app.get('/api/transactions/unmatched', (_req: Request, res: Response) => {
      res.status(501).json({ error: 'Not implemented: requires transaction data from Actual Budget' });
    });

    app.get('/api/connectors', (_req: Request, res: Response) => {
      if (!connectorRegistry) {
        res.json([]);
        return;
      }
      const connectors = connectorRegistry.getAll().map((c) => ({
        providerId: c.providerId,
        registered: true,
      }));
      res.json(connectors);
    });

    app.post('/api/connectors/:id/test', async (req: Request, res: Response) => {
      if (!connectorRegistry) {
        res.status(404).json({ error: 'No connector registry configured' });
        return;
      }
      const connector = connectorRegistry.get(req.params.id as string);
      if (!connector) {
        res.status(404).json({ error: `Connector "${req.params.id}" not found` });
        return;
      }
      try {
        const result = await connector.testConnection();
        res.json(result);
      } catch (error) {
        console.error('Error testing connector:', error);
        res.status(500).json({ error: 'Failed to test connector' });
      }
    });

    app.get('/api/receipt-stats', (_req: Request, res: Response) => {
      res.json(receiptStore.getStats());
    });

    app.get('/api/veryfi/profiles', async (_req: Request, res: Response) => {
      if (!deps.getVeryfiProfiles) {
        res.status(501).json({ error: 'Veryfi profiles not configured' });
        return;
      }
      try {
        const profiles = await deps.getVeryfiProfiles();
        res.json({ profiles });
      } catch (error) {
        console.error('Error fetching Veryfi profiles:', error);
        res.status(500).json({ error: 'Failed to fetch Veryfi profiles' });
      }
    });

    // Write endpoints for receipt operations
    app.post('/api/receipts/fetch', async (_req: Request, res: Response) => {
      if (!deps.onReceiptFetch) {
        res.status(501).json({ error: 'Receipt fetch not configured' });
        return;
      }
      try {
        const result = await deps.onReceiptFetch();
        res.json(result);
      } catch (error) {
        console.error('Error fetching receipts:', error);
        res.status(500).json({ error: 'Failed to fetch receipts' });
      }
    });

    app.post('/api/receipts/:id/match', (req: Request, res: Response) => {
      const { transactionId } = req.body as { transactionId?: string };
      if (!transactionId) {
        res.status(400).json({ error: 'transactionId is required' });
        return;
      }
      try {
        const matchId = receiptStore.createMatch(transactionId, req.params.id as string, 'manual');
        receiptStore.insertMatchHistory({
          receiptId: req.params.id as string,
          newTransactionId: transactionId,
          action: 'match',
          newMatchConfidence: 'manual',
          performedBy: 'user',
        });
        res.json({ matchId });
      } catch (error) {
        console.error('Error creating match:', error);
        res.status(500).json({ error: 'Failed to create match' });
      }
    });

    app.get('/api/receipts/:id/splits', (req: Request, res: Response) => {
      const match = receiptStore.getMatchForReceipt(req.params.id as string);
      if (!match) {
        res.status(404).json({ error: 'No match found for this receipt' });
        return;
      }
      const classifications = receiptStore.getClassificationsForMatch(match.id as string);
      res.json({ match, classifications });
    });

    app.post('/api/receipts/:id/classify', async (req: Request, res: Response) => {
      if (!deps.onReceiptClassify) {
        res.status(501).json({ error: 'Line-item classification not configured' });
        return;
      }
      const match = receiptStore.getMatchForReceipt(req.params.id as string);
      if (!match) {
        res.status(404).json({ error: 'No match found for this receipt' });
        return;
      }
      try {
        await deps.onReceiptClassify(match.id as string);
        res.json({ success: true });
      } catch (error) {
        console.error('Error classifying receipt:', error);
        res.status(500).json({ error: 'Failed to classify receipt' });
      }
    });

    app.post('/api/receipts/:id/apply', async (req: Request, res: Response) => {
      if (!deps.onReceiptApplySplit) {
        res.status(501).json({ error: 'Split transactions not configured' });
        return;
      }
      const match = receiptStore.getMatchForReceipt(req.params.id as string);
      if (!match) {
        res.status(404).json({ error: 'No match found for this receipt' });
        return;
      }
      try {
        await deps.onReceiptApplySplit(match.id as string);
        res.json({ success: true });
      } catch (error) {
        console.error('Error applying split:', error);
        res.status(500).json({ error: String(error instanceof Error ? error.message : error) });
      }
    });

    app.post('/api/matches/:id/unmatch', async (req: Request, res: Response) => {
      if (!deps.onReceiptUnmatch && !deps.onReceiptRollback) {
        res.status(501).json({ error: 'Unmatch not configured' });
        return;
      }
      try {
        const match = receiptStore.getMatch(req.params.id as string);
        if (!match) {
          res.status(404).json({ error: 'Match not found' });
          return;
        }
        if (match.status === 'applied' && deps.onReceiptRollback) {
          await deps.onReceiptRollback(req.params.id as string);
        }
        if (deps.onReceiptUnmatch) {
          deps.onReceiptUnmatch(req.params.id as string);
        }
        res.json({ success: true });
      } catch (error) {
        console.error('Error unmatching:', error);
        res.status(500).json({ error: String(error instanceof Error ? error.message : error) });
      }
    });

    app.post('/api/matches/:id/rematch', (req: Request, res: Response) => {
      if (!deps.onReceiptRematch) {
        res.status(501).json({ error: 'Rematch not configured' });
        return;
      }
      const { transactionId } = req.body as { transactionId?: string };
      if (!transactionId) {
        res.status(400).json({ error: 'transactionId is required' });
        return;
      }
      try {
        const newMatchId = deps.onReceiptRematch(req.params.id as string, transactionId);
        res.json({ matchId: newMatchId });
      } catch (error) {
        console.error('Error rematching:', error);
        res.status(500).json({ error: String(error instanceof Error ? error.message : error) });
      }
    });

    app.get('/api/matches/:id/history', (req: Request, res: Response) => {
      const match = receiptStore.getMatch(req.params.id as string);
      if (!match) {
        res.status(404).json({ error: 'Match not found' });
        return;
      }
      const history = receiptStore.getMatchHistory(match.receiptId as string);
      res.json(history);
    });

    // --- Batch endpoints ---
    app.post('/api/batch/classify', async (req: Request, res: Response) => {
      if (!deps.onBatchClassify) { res.status(501).json({ error: 'Batch classify not configured' }); return; }
      try {
        const result = await deps.onBatchClassify(req.body as BatchRequest);
        res.json(result);
      } catch (error) {
        console.error('Batch classify error:', error);
        res.status(500).json({ error: 'Batch classify failed' });
      }
    });

    app.post('/api/batch/approve', (req: Request, res: Response) => {
      if (!deps.onBatchApprove) { res.status(501).json({ error: 'Batch approve not configured' }); return; }
      try {
        const result = deps.onBatchApprove(req.body as BatchRequest);
        res.json(result);
      } catch (error) {
        console.error('Batch approve error:', error);
        res.status(500).json({ error: 'Batch approve failed' });
      }
    });

    app.post('/api/batch/apply', async (req: Request, res: Response) => {
      if (!deps.onBatchApply) { res.status(501).json({ error: 'Batch apply not configured' }); return; }
      try {
        const result = await deps.onBatchApply(req.body as BatchRequest);
        res.json(result);
      } catch (error) {
        console.error('Batch apply error:', error);
        res.status(500).json({ error: 'Batch apply failed' });
      }
    });

    app.post('/api/batch/unmatch', (req: Request, res: Response) => {
      if (!deps.onBatchUnmatch) { res.status(501).json({ error: 'Batch unmatch not configured' }); return; }
      try {
        const result = deps.onBatchUnmatch(req.body as BatchRequest);
        res.json(result);
      } catch (error) {
        console.error('Batch unmatch error:', error);
        res.status(500).json({ error: 'Batch unmatch failed' });
      }
    });

    app.post('/api/batch/reject', (req: Request, res: Response) => {
      if (!deps.onBatchReject) { res.status(501).json({ error: 'Batch reject not configured' }); return; }
      try {
        const result = deps.onBatchReject(req.body as BatchRequest);
        res.json(result);
      } catch (error) {
        console.error('Batch reject error:', error);
        res.status(500).json({ error: 'Batch reject failed' });
      }
    });

    app.post('/api/batch/reclassify', async (req: Request, res: Response) => {
      if (!deps.onBatchReclassify) { res.status(501).json({ error: 'Batch reclassify not configured' }); return; }
      try {
        const result = await deps.onBatchReclassify(req.body as BatchRequest);
        res.json(result);
      } catch (error) {
        console.error('Batch reclassify error:', error);
        res.status(500).json({ error: 'Batch reclassify failed' });
      }
    });

    // --- Reset & Rematch ---
    app.post('/api/batch/reset-rematch', async (_req: Request, res: Response) => {
      if (!deps.onResetAndRematch) {
        res.status(501).json({ error: 'Reset & rematch not configured' });
        return;
      }
      try {
        const result = await deps.onResetAndRematch();
        res.json(result);
      } catch (error) {
        console.error('Reset & rematch error:', error);
        res.status(500).json({ error: 'Reset & rematch failed' });
      }
    });

    // --- Tax-exempt category management ---
    app.get('/api/tax-exempt-categories', (_req: Request, res: Response) => {
      res.json(receiptStore.getTaxExemptCategoriesAll());
    });

    app.post('/api/tax-exempt-categories', (req: Request, res: Response) => {
      const { namePrefix, reason } = req.body as { namePrefix?: string; reason?: string };
      if (!namePrefix || !namePrefix.trim()) {
        res.status(400).json({ error: 'namePrefix is required' });
        return;
      }
      receiptStore.addTaxExemptPrefix(namePrefix.trim(), reason);
      res.json({ success: true });
    });

    app.delete('/api/tax-exempt-categories/:namePrefix', (req: Request, res: Response) => {
      const ok = receiptStore.removeTaxExemptPrefix(req.params.namePrefix as string);
      if (!ok) {
        res.status(404).json({ error: 'Prefix not found' });
        return;
      }
      res.json({ success: true });
    });

    // --- Transaction details (live lookup from Actual Budget) ---
    app.get('/api/transactions/:id/details', async (req: Request, res: Response) => {
      if (!deps.getTransactionDetails) {
        res.status(501).json({ error: 'Not configured' });
        return;
      }
      try {
        const details = await deps.getTransactionDetails(req.params.id as string);
        if (!details) {
          res.status(404).json({ error: 'Transaction not found' });
          return;
        }
        res.json(details);
      } catch (error) {
        console.error('Error fetching transaction details:', error);
        res.status(500).json({ error: 'Failed to fetch transaction' });
      }
    });

    // --- Bulk transaction details (for queue page lazy loading) ---
    app.post('/api/transactions/bulk-details', async (req: Request, res: Response) => {
      if (!deps.getTransactionsBulk) {
        res.status(501).json({ error: 'Not configured' });
        return;
      }
      const { transactionIds } = req.body as { transactionIds?: string[] };
      if (!transactionIds || !Array.isArray(transactionIds) || transactionIds.length === 0) {
        res.json({});
        return;
      }
      try {
        const ids = transactionIds.slice(0, 200);
        const result = await deps.getTransactionsBulk(ids);
        res.json(result);
      } catch (error) {
        console.error('Error fetching bulk transaction details:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
      }
    });

    // --- Keep Category: mark matches as applied without classification ---
    app.post('/api/batch/keep-category', (req: Request, res: Response) => {
      const { matchIds } = req.body as { matchIds?: string[] };
      if (!matchIds || !Array.isArray(matchIds) || matchIds.length === 0) {
        res.json({
          processed: 0, succeeded: 0, failed: 0, errors: [],
        });
        return;
      }
      const result: {
        processed: number; succeeded: number; failed: number;
        errors: { matchId: string; error: string }[];
      } = {
        processed: matchIds.length, succeeded: 0, failed: 0, errors: [],
      };
      // eslint-disable-next-line no-restricted-syntax
      for (const matchId of matchIds) {
        const match = receiptStore.getMatch(matchId);
        if (!match) {
          result.failed++;
          result.errors.push({ matchId, error: 'Match not found' });
          continue;
        }
        if (match.status === 'applied') {
          result.failed++;
          result.errors.push({ matchId, error: 'Match already applied' });
          continue;
        }
        receiptStore.updateMatchStatus(matchId, 'applied');
        receiptStore.insertMatchHistory({
          receiptId: match.receiptId as string,
          newTransactionId: match.transactionId as string,
          action: 'keep-category',
          oldMatchConfidence: match.matchConfidence as string,
          performedBy: 'user',
        });
        result.succeeded++;
      }
      console.log(`Batch keep-category: ${result.succeeded}/${result.processed} succeeded`);
      res.json(result);
    });

    app.patch('/api/line-items/:id', (req: Request, res: Response) => {
      const { status, categoryId, categoryName } = req.body as {
        status?: string;
        categoryId?: string;
        categoryName?: string;
      };

      const id = req.params.id as string;
      const lineItem = receiptStore.getLineItemClassification(id);
      if (!lineItem) {
        res.status(404).json({ error: 'Line item not found' });
        return;
      }
      const matchId = lineItem.receiptMatchId as string;

      // Category change: update category + reconcile tax
      if (categoryId) {
        receiptStore.updateLineItemClassification(id, {
          suggestedCategoryId: categoryId,
          suggestedCategoryName: categoryName,
          classificationType: 'manual',
          confidence: 'high',
        });
        const classifications = reconcileMatchTax(receiptStore, matchId);
        res.json({ success: true, classifications });
        return;
      }

      // Status change
      if (status !== 'approved' && status !== 'rejected') {
        res.status(400).json({ error: 'Status must be "approved" or "rejected"' });
        return;
      }
      receiptStore.updateLineItemStatus(id, status);

      // Auto-promote match status when all line items are approved
      const all = receiptStore.getClassificationsForMatch(matchId);
      const allApproved = all.length > 0
        && all.every((c) => c.status === 'approved');
      if (allApproved) {
        receiptStore.updateMatchStatus(matchId, 'approved');
      }

      res.json({ success: true, classifications: all });
    });
  }

  return app;
}

function parseReceiptFilter(query: Record<string, unknown>): { status?: string; page?: number; limit?: number } {
  return {
    status: query.status as string | undefined,
    page: query.page ? Number(query.page) : 1,
    limit: query.limit ? Number(query.limit) : 50,
  };
}

function parseMatchQueueFilter(query: Record<string, unknown>): MatchQueueFilter {
  return {
    status: query.status as string | undefined,
    confidence: query.confidence as string | undefined,
    overridesExisting: query.overridesExisting as string | undefined,
    vendor: query.vendor as string | undefined,
    dateFrom: query.dateFrom as string | undefined,
    dateTo: query.dateTo as string | undefined,
    amountMin: query.amountMin ? Number(query.amountMin) : undefined,
    amountMax: query.amountMax ? Number(query.amountMax) : undefined,
    sortBy: query.sortBy as string | undefined,
    sortDir: (query.sortDir as string)?.toLowerCase() === 'asc' ? 'asc' : 'desc',
    page: query.page ? Number(query.page) : 1,
    limit: query.limit ? Number(query.limit) : 50,
  };
}

function parseFilter(query: Record<string, unknown>): ClassificationFilter {
  return {
    status: query.status as string | undefined,
    accountName: query.accountName as string | undefined,
    suggestedCategoryGroup: query.categoryGroup as string | undefined,
    classificationType: query.type as string | undefined,
    payeeSearch: query.payee as string | undefined,
    dateFrom: query.dateFrom as string | undefined,
    dateTo: query.dateTo as string | undefined,
    amountMin: query.amountMin ? Number(query.amountMin) : undefined,
    amountMax: query.amountMax ? Number(query.amountMax) : undefined,
    runId: query.runId as string | undefined,
    sortBy: query.sortBy as string | undefined,
    sortDir: (query.sortDir as string)?.toLowerCase() === 'asc' ? 'asc' : 'desc',
    page: query.page ? Number(query.page) : 1,
    limit: query.limit ? Number(query.limit) : 50,
  };
}
