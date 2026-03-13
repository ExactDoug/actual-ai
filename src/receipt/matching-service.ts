import ReceiptStore from './receipt-store';
import { MatchConfidence } from './types';

interface Transaction {
  id: string;
  amount: number;
  date: string | number;
  payee?: string;
  imported_payee?: string;
  hasCategory?: boolean;
  categoryId?: string;
}

interface MatchSummary {
  matched: number;
  exact: number;
  probable: number;
  possible: number;
  unmatched: number;
}

interface CandidateMatch {
  transactionId: string;
  receiptId: string;
  confidence: MatchConfidence;
  amountDiff: number;
  overridesExisting: boolean;
  categoryId?: string;
}

const VENDOR_SUFFIXES = /\b(inc|llc|corp|corporation|incorporated|ltd|limited|co|company)\b\.?/gi;

/**
 * Parse a date that may be YYYY-MM-DD string or YYYYMMDD integer
 * (Actual Budget stores dates as integers like 20251106).
 */
function parseDate(date: string | number): Date {
  const s = String(date);
  if (/^\d{8}$/.test(s)) {
    // YYYYMMDD integer format → insert hyphens
    return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  }
  return new Date(s + 'T00:00:00Z');
}

function daysBetween(dateA: string | number, dateB: string | number): number {
  const a = parseDate(dateA);
  const b = parseDate(dateB);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return Infinity;
  const diffMs = Math.abs(a.getTime() - b.getTime());
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

function normalizeVendor(name: string): string {
  return name
    .replace(VENDOR_SUFFIXES, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')  // strip punctuation (apostrophes, #, etc.)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function vendorMatch(
  vendorName: string,
  payee: string | undefined,
  importedPayee: string | undefined,
): boolean {
  if (!vendorName) return false;

  const normalizedVendor = normalizeVendor(vendorName);
  if (!normalizedVendor) return false;

  const candidates = [payee, importedPayee].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );

  if (candidates.length === 0) return false;

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeVendor(candidate);
    if (!normalizedCandidate) continue;

    if (
      normalizedCandidate.includes(normalizedVendor) ||
      normalizedVendor.includes(normalizedCandidate)
    ) {
      return true;
    }
  }

  return false;
}

class MatchingService {
  private store: ReceiptStore;
  private toleranceCents: number;
  private toleranceDays: number;
  private autoMatch: boolean;

  constructor(
    store: ReceiptStore,
    toleranceCents: number,
    toleranceDays: number,
    autoMatch: boolean,
  ) {
    this.store = store;
    this.toleranceCents = toleranceCents;
    this.toleranceDays = toleranceDays;
    this.autoMatch = autoMatch;
  }

  matchAll(transactions: Transaction[]): MatchSummary {
    const unmatchedReceipts = this.store.getUnmatchedReceipts();

    // Build a set of transaction IDs that already have a match
    const alreadyMatchedTxIds = new Set<string>();
    for (const tx of transactions) {
      if (this.store.getMatchForTransaction(tx.id) !== null) {
        alreadyMatchedTxIds.add(tx.id);
      }
    }

    const availableTransactions = transactions.filter(
      (tx) => !alreadyMatchedTxIds.has(tx.id) && tx.amount !== 0,
    );

    // For each receipt, find the best candidate transaction
    // candidatesByReceipt maps receiptId -> best candidate
    const candidatesByReceipt = new Map<string, CandidateMatch>();

    for (const receipt of unmatchedReceipts) {
      const receiptAmount = receipt.totalAmount as number;
      const receiptDate = receipt.date as string;
      const receiptVendor = (receipt.vendorName as string) ?? '';
      const receiptId = receipt.id as string;

      // Skip zero-amount receipts
      if (receiptAmount === 0) continue;

      const candidates: CandidateMatch[] = [];

      for (const tx of availableTransactions) {
        const amountDiff = Math.abs(receiptAmount - Math.abs(tx.amount));
        const amountMatches = amountDiff <= this.toleranceCents;

        if (!amountMatches) continue;

        const dateMatches = daysBetween(receiptDate, tx.date) <= this.toleranceDays;
        const vendorMatches = vendorMatch(receiptVendor, tx.payee, tx.imported_payee);

        let confidence: MatchConfidence;
        if (amountMatches && dateMatches && vendorMatches) {
          confidence = 'exact';
        } else if (amountMatches && (dateMatches || vendorMatches)) {
          confidence = 'probable';
        } else {
          confidence = 'possible';
        }

        candidates.push({
          transactionId: tx.id,
          receiptId,
          confidence,
          amountDiff,
          overridesExisting: !!tx.hasCategory,
          categoryId: tx.categoryId,
        });
      }

      if (candidates.length === 0) continue;

      // Pick the best candidate: highest confidence, then closest amount
      candidates.sort((a, b) => {
        const confidenceOrder: Record<MatchConfidence, number> = {
          exact: 0,
          probable: 1,
          possible: 2,
          manual: 3,
        };
        const confDiff = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
        if (confDiff !== 0) return confDiff;
        return a.amountDiff - b.amountDiff;
      });

      candidatesByReceipt.set(receiptId, candidates[0]);
    }

    // Resolve conflicts: if multiple receipts want the same transaction,
    // pick the best-scoring one
    const claimedTransactions = new Map<string, { receiptId: string; candidate: CandidateMatch }>();

    for (const [receiptId, candidate] of candidatesByReceipt) {
      const existing = claimedTransactions.get(candidate.transactionId);

      if (!existing) {
        claimedTransactions.set(candidate.transactionId, { receiptId, candidate });
        continue;
      }

      // Compare: prefer higher confidence, then closer amount
      const confidenceOrder: Record<MatchConfidence, number> = {
        exact: 0,
        probable: 1,
        possible: 2,
        manual: 3,
      };
      const existingScore = confidenceOrder[existing.candidate.confidence];
      const newScore = confidenceOrder[candidate.confidence];

      if (newScore < existingScore || (newScore === existingScore && candidate.amountDiff < existing.candidate.amountDiff)) {
        // New candidate wins; old one goes unmatched
        candidatesByReceipt.delete(existing.receiptId);
        claimedTransactions.set(candidate.transactionId, { receiptId, candidate });
      } else {
        // Existing wins; new one goes unmatched
        candidatesByReceipt.delete(receiptId);
      }
    }

    // Create matches and record history
    const summary: MatchSummary = {
      matched: 0,
      exact: 0,
      probable: 0,
      possible: 0,
      unmatched: 0,
    };

    for (const [, { candidate }] of claimedTransactions) {
      this.store.createMatch(candidate.transactionId, candidate.receiptId, candidate.confidence, candidate.overridesExisting, candidate.categoryId);

      this.store.insertMatchHistory({
        receiptId: candidate.receiptId,
        newTransactionId: candidate.transactionId,
        action: 'match',
        newMatchConfidence: candidate.confidence,
        performedBy: 'system',
      });

      summary.matched++;
      if (candidate.confidence === 'exact') summary.exact++;
      else if (candidate.confidence === 'probable') summary.probable++;
      else if (candidate.confidence === 'possible') summary.possible++;
    }

    // Count unmatched: receipts that started unmatched and remain unmatched
    summary.unmatched = unmatchedReceipts.filter(
      (r) => !claimedTransactions.has(
        candidatesByReceipt.get(r.id as string)?.transactionId ?? '',
      ) && !candidatesByReceipt.has(r.id as string),
    ).length;

    // Also count receipts that were removed from candidatesByReceipt due to conflicts
    // Actually, let's recompute: unmatched = total unmatched receipts that were eligible - matched
    const eligibleReceipts = unmatchedReceipts.filter(
      (r) => (r.totalAmount as number) !== 0,
    );
    summary.unmatched = eligibleReceipts.length - summary.matched;

    console.log(
      `Receipt matching complete: ${summary.matched} matched (${summary.exact} exact, ${summary.probable} probable, ${summary.possible} possible), ${summary.unmatched} unmatched`,
    );

    return summary;
  }

  unmatch(matchId: string): void {
    const match = this.store.getMatch(matchId);
    if (!match) {
      throw new Error(`Match not found: ${matchId}`);
    }

    if (match.status === 'applied') {
      throw new Error(
        `Cannot unmatch an applied match (${matchId}). Rollback the split first.`,
      );
    }

    this.store.deleteClassificationsForMatch(matchId);
    this.store.deleteMatch(matchId);

    this.store.insertMatchHistory({
      receiptId: match.receiptId as string,
      oldTransactionId: match.transactionId as string,
      action: 'unmatch',
      oldMatchConfidence: match.matchConfidence as MatchConfidence,
      performedBy: 'system',
    });
  }

  rematch(matchId: string, newTransactionId: string): string {
    const oldMatch = this.store.getMatch(matchId);
    if (!oldMatch) {
      throw new Error(`Match not found: ${matchId}`);
    }

    if (oldMatch.status === 'applied') {
      throw new Error(
        `Cannot rematch an applied match (${matchId}). Rollback the split first.`,
      );
    }

    this.store.insertMatchHistory({
      receiptId: oldMatch.receiptId as string,
      oldTransactionId: oldMatch.transactionId as string,
      newTransactionId,
      action: 'rematch',
      oldMatchConfidence: oldMatch.matchConfidence as MatchConfidence,
      newMatchConfidence: 'manual',
      performedBy: 'system',
    });

    this.store.deleteClassificationsForMatch(matchId);
    this.store.deleteMatch(matchId);

    const newMatchId = this.store.createMatch(
      newTransactionId,
      oldMatch.receiptId as string,
      'manual',
    );

    return newMatchId;
  }
}

export default MatchingService;
