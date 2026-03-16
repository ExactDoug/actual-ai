import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import ClassificationStore, { ClassificationFilter } from './classification-store';
import { authMiddleware, loginHandler, loginPage, COOKIE_NAME } from './auth';
import { renderDashboard, renderClassifications, renderHistory } from './views/renderer';

export interface WebServerDeps {
  actualPassword: string;
  classificationStore: ClassificationStore;
  onApply: (classifications: { id: string; transactionId: string; suggestedCategoryId: string; notes: string }[]) => Promise<{ applied: number; skipped: number }>;
  onTriggerClassify: () => Promise<void>;
  getCategories: () => Promise<{ id: string; name: string; group: string }[]>;
  getConfig: () => Record<string, unknown>;
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

  return app;
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
