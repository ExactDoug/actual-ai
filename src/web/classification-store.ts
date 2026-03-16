import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';

export interface ClassificationRecord {
  id: string;
  transactionId: string;
  date: string;
  amount: number;
  payee: string;
  importedPayee: string;
  notes: string;
  accountName: string;
  suggestedCategoryId: string;
  suggestedCategoryName: string;
  suggestedCategoryGroup: string;
  classificationType: string;
  matchedRuleName: string | null;
  newCategoryName: string | null;
  newGroupName: string | null;
  newGroupIsNew: number | null;
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  classifiedAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
  runId: string;
}

export interface ClassificationFilter {
  status?: string;
  accountName?: string;
  suggestedCategoryGroup?: string;
  classificationType?: string;
  payeeSearch?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
  runId?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface RunSummary {
  runId: string;
  classifiedAt: string;
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  applied: number;
}

export interface DashboardStats {
  totalPending: number;
  totalApproved: number;
  totalApplied: number;
  totalRejected: number;
  lastRunAt: string | null;
}

class ClassificationStore {
  private db: Database.Database;

  constructor(dataDir: string) {
    const dbPath = path.join(dataDir, 'classifications.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS classifications (
        id TEXT PRIMARY KEY,
        transactionId TEXT NOT NULL,
        date TEXT,
        amount INTEGER,
        payee TEXT,
        importedPayee TEXT,
        notes TEXT,
        accountName TEXT,
        suggestedCategoryId TEXT,
        suggestedCategoryName TEXT,
        suggestedCategoryGroup TEXT,
        classificationType TEXT,
        matchedRuleName TEXT,
        newCategoryName TEXT,
        newGroupName TEXT,
        newGroupIsNew INTEGER,
        status TEXT DEFAULT 'pending',
        classifiedAt TEXT,
        reviewedAt TEXT,
        appliedAt TEXT,
        runId TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_classifications_status ON classifications(status);
      CREATE INDEX IF NOT EXISTS idx_classifications_runId ON classifications(runId);
      CREATE INDEX IF NOT EXISTS idx_classifications_transactionId ON classifications(transactionId);
    `);
  }

  insert(record: Omit<ClassificationRecord, 'id' | 'status' | 'reviewedAt' | 'appliedAt'>): string {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO classifications (
        id, transactionId, date, amount, payee, importedPayee, notes, accountName,
        suggestedCategoryId, suggestedCategoryName, suggestedCategoryGroup,
        classificationType, matchedRuleName, newCategoryName, newGroupName, newGroupIsNew,
        status, classifiedAt, runId
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
      )
    `);
    stmt.run(
      id, record.transactionId, record.date, record.amount,
      record.payee, record.importedPayee, record.notes, record.accountName,
      record.suggestedCategoryId, record.suggestedCategoryName, record.suggestedCategoryGroup,
      record.classificationType, record.matchedRuleName,
      record.newCategoryName, record.newGroupName, record.newGroupIsNew,
      record.classifiedAt, record.runId,
    );
    return id;
  }

  getById(id: string): ClassificationRecord | undefined {
    return this.db.prepare('SELECT * FROM classifications WHERE id = ?').get(id) as ClassificationRecord | undefined;
  }

  list(filter: ClassificationFilter): { rows: ClassificationRecord[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.accountName) {
      conditions.push('accountName = ?');
      params.push(filter.accountName);
    }
    if (filter.suggestedCategoryGroup) {
      conditions.push('suggestedCategoryGroup = ?');
      params.push(filter.suggestedCategoryGroup);
    }
    if (filter.classificationType) {
      conditions.push('classificationType = ?');
      params.push(filter.classificationType);
    }
    if (filter.payeeSearch) {
      conditions.push('(payee LIKE ? OR importedPayee LIKE ?)');
      params.push(`%${filter.payeeSearch}%`, `%${filter.payeeSearch}%`);
    }
    if (filter.dateFrom) {
      conditions.push('date >= ?');
      params.push(filter.dateFrom);
    }
    if (filter.dateTo) {
      conditions.push('date <= ?');
      params.push(filter.dateTo);
    }
    if (filter.amountMin != null) {
      conditions.push('amount >= ?');
      params.push(filter.amountMin);
    }
    if (filter.amountMax != null) {
      conditions.push('amount <= ?');
      params.push(filter.amountMax);
    }
    if (filter.runId) {
      conditions.push('runId = ?');
      params.push(filter.runId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sortCol = ['date', 'amount', 'payee', 'accountName', 'suggestedCategoryName', 'status', 'classifiedAt'].includes(filter.sortBy ?? '')
      ? filter.sortBy! : 'classifiedAt';
    const sortDir = filter.sortDir === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = ((filter.page ?? 1) - 1) * limit;

    const total = (this.db.prepare(`SELECT COUNT(*) as count FROM classifications ${where}`).get(...params) as { count: number }).count;
    const rows = this.db.prepare(
      `SELECT * FROM classifications ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as ClassificationRecord[];

    return { rows, total };
  }

  updateStatus(id: string, status: 'approved' | 'rejected'): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      'UPDATE classifications SET status = ?, reviewedAt = ? WHERE id = ? AND status IN (\'pending\', \'approved\', \'rejected\')',
    ).run(status, now, id);
    return result.changes > 0;
  }

  batchUpdateStatus(ids: string[], status: 'approved' | 'rejected'): number {
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    const result = this.db.prepare(
      `UPDATE classifications SET status = ?, reviewedAt = ? WHERE id IN (${placeholders}) AND status IN ('pending', 'approved', 'rejected')`,
    ).run(status, now, ...ids);
    return result.changes;
  }

  batchUpdateByFilter(filter: ClassificationFilter, status: 'approved' | 'rejected'): number {
    const conditions: string[] = ["status IN ('pending', 'approved', 'rejected')"];
    const params: unknown[] = [status, new Date().toISOString()];

    if (filter.status && filter.status !== 'applied') {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.accountName) {
      conditions.push('accountName = ?');
      params.push(filter.accountName);
    }
    if (filter.suggestedCategoryGroup) {
      conditions.push('suggestedCategoryGroup = ?');
      params.push(filter.suggestedCategoryGroup);
    }
    if (filter.classificationType) {
      conditions.push('classificationType = ?');
      params.push(filter.classificationType);
    }
    if (filter.payeeSearch) {
      conditions.push('(payee LIKE ? OR importedPayee LIKE ?)');
      params.push(`%${filter.payeeSearch}%`, `%${filter.payeeSearch}%`);
    }
    if (filter.runId) {
      conditions.push('runId = ?');
      params.push(filter.runId);
    }

    const where = conditions.join(' AND ');
    const result = this.db.prepare(
      `UPDATE classifications SET status = ?, reviewedAt = ? WHERE ${where}`,
    ).run(...params);
    return result.changes;
  }

  markApplied(ids: string[]): number {
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    const result = this.db.prepare(
      `UPDATE classifications SET status = 'applied', appliedAt = ? WHERE id IN (${placeholders}) AND status = 'approved'`,
    ).run(now, ...ids);
    return result.changes;
  }

  getApproved(): ClassificationRecord[] {
    return this.db.prepare("SELECT * FROM classifications WHERE status = 'approved' ORDER BY classifiedAt").all() as ClassificationRecord[];
  }

  getRuns(): RunSummary[] {
    return this.db.prepare(`
      SELECT
        runId,
        MIN(classifiedAt) as classifiedAt,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) as applied
      FROM classifications
      GROUP BY runId
      ORDER BY classifiedAt DESC
      LIMIT 50
    `).all() as RunSummary[];
  }

  getStats(): DashboardStats {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as totalPending,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as totalApproved,
        SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) as totalApplied,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as totalRejected,
        MAX(classifiedAt) as lastRunAt
      FROM classifications
    `).get() as DashboardStats;
    return row;
  }

  getDistinctAccounts(): string[] {
    return (this.db.prepare('SELECT DISTINCT accountName FROM classifications ORDER BY accountName').all() as { accountName: string }[])
      .map((r) => r.accountName);
  }

  getDistinctCategoryGroups(): string[] {
    return (this.db.prepare('SELECT DISTINCT suggestedCategoryGroup FROM classifications ORDER BY suggestedCategoryGroup').all() as { suggestedCategoryGroup: string }[])
      .map((r) => r.suggestedCategoryGroup);
  }

  clearPendingForTransaction(transactionId: string): void {
    this.db.prepare("DELETE FROM classifications WHERE transactionId = ? AND status = 'pending'").run(transactionId);
  }

  /** Get transaction IDs that already have a non-rejected classification.
   *  Used to skip re-classifying transactions that already have a result. */
  getClassifiedTransactionIds(): Set<string> {
    const rows = this.db.prepare(
      "SELECT DISTINCT transactionId FROM classifications WHERE status != 'rejected'",
    ).all() as { transactionId: string }[];
    return new Set(rows.map((r) => r.transactionId));
  }

  close(): void {
    this.db.close();
  }
}

export default ClassificationStore;
