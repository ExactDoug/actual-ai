import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

class ReceiptStore {
  private db: Database.Database;

  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, 'receipts.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY,
        externalId TEXT NOT NULL,
        providerId TEXT NOT NULL,
        vendorName TEXT,
        vendorId TEXT,
        totalAmount INTEGER NOT NULL,
        date TEXT NOT NULL,
        currency TEXT DEFAULT 'USD',
        lineItemCount INTEGER DEFAULT 0,
        taxAmount INTEGER DEFAULT 0,
        receiptData TEXT NOT NULL,
        fetchedAt TEXT NOT NULL,
        UNIQUE(providerId, externalId)
      );

      CREATE TABLE IF NOT EXISTS receipt_matches (
        id TEXT PRIMARY KEY,
        transactionId TEXT NOT NULL,
        receiptId TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
        matchConfidence TEXT NOT NULL,
        matchedAt TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        preSplitSnapshot TEXT,
        UNIQUE(transactionId, receiptId)
      );

      CREATE TABLE IF NOT EXISTS receipt_match_history (
        id TEXT PRIMARY KEY,
        receiptId TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
        oldTransactionId TEXT,
        newTransactionId TEXT,
        action TEXT NOT NULL,
        oldMatchConfidence TEXT,
        newMatchConfidence TEXT,
        reason TEXT,
        performedAt TEXT NOT NULL,
        performedBy TEXT DEFAULT 'system'
      );

      CREATE TABLE IF NOT EXISTS line_item_classifications (
        id TEXT PRIMARY KEY,
        receiptMatchId TEXT NOT NULL REFERENCES receipt_matches(id) ON DELETE CASCADE,
        lineItemIndex INTEGER NOT NULL,
        description TEXT NOT NULL,
        quantity REAL DEFAULT 1,
        unitPrice INTEGER NOT NULL,
        totalPrice INTEGER NOT NULL,
        taxable INTEGER,
        allocatedTax INTEGER DEFAULT 0,
        amountWithTax INTEGER NOT NULL,
        suggestedCategoryId TEXT,
        suggestedCategoryName TEXT,
        classificationType TEXT,
        confidence TEXT,
        status TEXT DEFAULT 'pending',
        notes TEXT,
        UNIQUE(receiptMatchId, lineItemIndex)
      );

      CREATE INDEX IF NOT EXISTS idx_receipts_provider_external
        ON receipts(providerId, externalId);
      CREATE INDEX IF NOT EXISTS idx_receipt_matches_status
        ON receipt_matches(status);
      CREATE INDEX IF NOT EXISTS idx_receipt_matches_transactionId
        ON receipt_matches(transactionId);
      CREATE INDEX IF NOT EXISTS idx_receipt_matches_receiptId
        ON receipt_matches(receiptId);

      CREATE VIEW IF NOT EXISTS transaction_receipt_status AS
      SELECT
        rm.transactionId,
        rm.receiptId,
        rm.status AS matchStatus,
        rm.matchConfidence,
        r.vendorName,
        r.totalAmount,
        r.date AS receiptDate,
        r.lineItemCount,
        (SELECT COUNT(*) FROM line_item_classifications lic
         WHERE lic.receiptMatchId = rm.id AND lic.status = 'approved') AS approvedItems,
        (SELECT COUNT(*) FROM line_item_classifications lic
         WHERE lic.receiptMatchId = rm.id) AS totalItems
      FROM receipt_matches rm
      JOIN receipts r ON r.id = rm.receiptId;
    `);
  }

  // ---------------------------------------------------------------------------
  // Receipts
  // ---------------------------------------------------------------------------

  upsertReceipt(receipt: {
    externalId: string;
    providerId: string;
    vendorName: string;
    vendorId?: string;
    totalAmount: number;
    date: string;
    currency: string;
    lineItemCount: number;
    taxAmount: number;
    receiptData: string;
    fetchedAt: string;
  }): string {
    const existing = this.db.prepare(
      'SELECT id FROM receipts WHERE providerId = ? AND externalId = ?',
    ).get(receipt.providerId, receipt.externalId) as { id: string } | undefined;

    const id = existing?.id ?? crypto.randomUUID();

    const stmt = this.db.prepare(`
      INSERT INTO receipts (
        id, externalId, providerId, vendorName, vendorId, totalAmount,
        date, currency, lineItemCount, taxAmount, receiptData, fetchedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(providerId, externalId) DO UPDATE SET
        vendorName = excluded.vendorName,
        vendorId = excluded.vendorId,
        totalAmount = excluded.totalAmount,
        date = excluded.date,
        currency = excluded.currency,
        lineItemCount = excluded.lineItemCount,
        taxAmount = excluded.taxAmount,
        receiptData = excluded.receiptData,
        fetchedAt = excluded.fetchedAt
    `);

    stmt.run(
      id,
      receipt.externalId,
      receipt.providerId,
      receipt.vendorName,
      receipt.vendorId ?? null,
      receipt.totalAmount,
      receipt.date,
      receipt.currency,
      receipt.lineItemCount,
      receipt.taxAmount,
      receipt.receiptData,
      receipt.fetchedAt,
    );

    return id;
  }

  getReceipt(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  getReceiptByExternalId(providerId: string, externalId: string): Record<string, unknown> | undefined {
    return this.db.prepare(
      'SELECT * FROM receipts WHERE providerId = ? AND externalId = ?',
    ).get(providerId, externalId) as Record<string, unknown> | undefined;
  }

  listReceipts(filter: { status?: string; page?: number; limit?: number }): { rows: Record<string, unknown>[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.status) {
      conditions.push('rm.status = ?');
      params.push(filter.status);
    }

    const hasStatusFilter = conditions.length > 0;
    const joinClause = hasStatusFilter
      ? 'JOIN receipt_matches rm ON rm.receiptId = r.id'
      : 'LEFT JOIN receipt_matches rm ON rm.receiptId = r.id';
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = ((filter.page ?? 1) - 1) * limit;

    const total = (this.db.prepare(
      `SELECT COUNT(*) as count FROM receipts r ${joinClause} ${where}`,
    ).get(...params) as { count: number }).count;

    const rows = this.db.prepare(
      `SELECT r.*, rm.status AS matchStatus, rm.matchConfidence, rm.transactionId
       FROM receipts r ${joinClause} ${where}
       ORDER BY r.fetchedAt DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Record<string, unknown>[];

    return { rows, total };
  }

  findNearDuplicates(
    vendorName: string,
    date: string,
    totalAmount: number,
    toleranceCents: number,
  ): Record<string, unknown>[] {
    return this.db.prepare(
      `SELECT * FROM receipts
       WHERE vendorName = ? AND date = ?
         AND totalAmount BETWEEN ? AND ?`,
    ).all(
      vendorName,
      date,
      totalAmount - toleranceCents,
      totalAmount + toleranceCents,
    ) as Record<string, unknown>[];
  }

  // ---------------------------------------------------------------------------
  // Matches
  // ---------------------------------------------------------------------------

  createMatch(transactionId: string, receiptId: string, confidence: string): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO receipt_matches (id, transactionId, receiptId, matchConfidence, matchedAt, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(id, transactionId, receiptId, confidence, now);
    return id;
  }

  updateMatchStatus(matchId: string, status: string): boolean {
    const result = this.db.prepare(
      'UPDATE receipt_matches SET status = ? WHERE id = ?',
    ).run(status, matchId);
    return result.changes > 0;
  }

  getMatch(matchId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM receipt_matches WHERE id = ?').get(matchId) as Record<string, unknown> | undefined;
  }

  getMatchForReceipt(receiptId: string): Record<string, unknown> | null {
    return (this.db.prepare(
      'SELECT * FROM receipt_matches WHERE receiptId = ?',
    ).get(receiptId) as Record<string, unknown>) ?? null;
  }

  getMatchForTransaction(transactionId: string): Record<string, unknown> | null {
    return (this.db.prepare(
      'SELECT * FROM receipt_matches WHERE transactionId = ?',
    ).get(transactionId) as Record<string, unknown>) ?? null;
  }

  getUnmatchedReceipts(): Record<string, unknown>[] {
    return this.db.prepare(
      `SELECT r.* FROM receipts r
       LEFT JOIN receipt_matches rm ON rm.receiptId = r.id
       WHERE rm.id IS NULL`,
    ).all() as Record<string, unknown>[];
  }

  getMatchesByStatus(status: string): Record<string, unknown>[] {
    return this.db.prepare(
      'SELECT * FROM receipt_matches WHERE status = ?',
    ).all(status) as Record<string, unknown>[];
  }

  setPreSplitSnapshot(matchId: string, snapshot: string): boolean {
    const result = this.db.prepare(
      'UPDATE receipt_matches SET preSplitSnapshot = ? WHERE id = ?',
    ).run(snapshot, matchId);
    return result.changes > 0;
  }

  deleteMatch(matchId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM receipt_matches WHERE id = ?',
    ).run(matchId);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Match History
  // ---------------------------------------------------------------------------

  insertMatchHistory(entry: {
    receiptId: string;
    oldTransactionId?: string;
    newTransactionId?: string;
    action: string;
    oldMatchConfidence?: string;
    newMatchConfidence?: string;
    reason?: string;
    performedBy?: string;
  }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO receipt_match_history (
        id, receiptId, oldTransactionId, newTransactionId, action,
        oldMatchConfidence, newMatchConfidence, reason, performedAt, performedBy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.receiptId,
      entry.oldTransactionId ?? null,
      entry.newTransactionId ?? null,
      entry.action,
      entry.oldMatchConfidence ?? null,
      entry.newMatchConfidence ?? null,
      entry.reason ?? null,
      now,
      entry.performedBy ?? 'system',
    );
    return id;
  }

  getMatchHistory(receiptId: string): Record<string, unknown>[] {
    return this.db.prepare(
      'SELECT * FROM receipt_match_history WHERE receiptId = ? ORDER BY performedAt DESC',
    ).all(receiptId) as Record<string, unknown>[];
  }

  // ---------------------------------------------------------------------------
  // Line Item Classifications
  // ---------------------------------------------------------------------------

  insertLineItemClassification(record: {
    receiptMatchId: string;
    lineItemIndex: number;
    description: string;
    quantity?: number;
    unitPrice: number;
    totalPrice: number;
    taxable?: boolean | null;
    allocatedTax?: number;
    amountWithTax: number;
    suggestedCategoryId?: string;
    suggestedCategoryName?: string;
    classificationType?: string;
    confidence?: string;
    notes?: string;
  }): string {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO line_item_classifications (
        id, receiptMatchId, lineItemIndex, description, quantity,
        unitPrice, totalPrice, taxable, allocatedTax, amountWithTax,
        suggestedCategoryId, suggestedCategoryName, classificationType,
        confidence, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id,
      record.receiptMatchId,
      record.lineItemIndex,
      record.description,
      record.quantity ?? 1,
      record.unitPrice,
      record.totalPrice,
      record.taxable == null ? null : record.taxable ? 1 : 0,
      record.allocatedTax ?? 0,
      record.amountWithTax,
      record.suggestedCategoryId ?? null,
      record.suggestedCategoryName ?? null,
      record.classificationType ?? null,
      record.confidence ?? null,
      record.notes ?? null,
    );
    return id;
  }

  getClassificationsForMatch(matchId: string): Record<string, unknown>[] {
    return this.db.prepare(
      'SELECT * FROM line_item_classifications WHERE receiptMatchId = ? ORDER BY lineItemIndex',
    ).all(matchId) as Record<string, unknown>[];
  }

  updateLineItemStatus(id: string, status: string): boolean {
    const result = this.db.prepare(
      'UPDATE line_item_classifications SET status = ? WHERE id = ?',
    ).run(status, id);
    return result.changes > 0;
  }

  deleteClassificationsForMatch(matchId: string): number {
    const result = this.db.prepare(
      'DELETE FROM line_item_classifications WHERE receiptMatchId = ?',
    ).run(matchId);
    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  getStats(): {
    totalReceipts: number;
    totalMatched: number;
    pending: number;
    classified: number;
    approved: number;
    applied: number;
    rejected: number;
    totalUnmatched: number;
  } {
    const totalReceipts = (this.db.prepare(
      'SELECT COUNT(*) as count FROM receipts',
    ).get() as { count: number }).count;

    const statusCounts = this.db.prepare(`
      SELECT
        COUNT(*) as totalMatched,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'classified' THEN 1 ELSE 0 END) as classified,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) as applied,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
      FROM receipt_matches
    `).get() as {
      totalMatched: number;
      pending: number;
      classified: number;
      approved: number;
      applied: number;
      rejected: number;
    };

    const totalUnmatched = (this.db.prepare(
      `SELECT COUNT(*) as count FROM receipts r
       LEFT JOIN receipt_matches rm ON rm.receiptId = r.id
       WHERE rm.id IS NULL`,
    ).get() as { count: number }).count;

    return {
      totalReceipts,
      totalMatched: statusCounts.totalMatched,
      pending: statusCounts.pending,
      classified: statusCounts.classified,
      approved: statusCounts.approved,
      applied: statusCounts.applied,
      rejected: statusCounts.rejected,
      totalUnmatched,
    };
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}

export default ReceiptStore;
