import ReceiptStore from './receipt-store';
import { MatchConfidence } from './types';

export interface Transaction {
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
  phase1Matched: number;
  phase2Matched: number;
  phase3Matched: number;
}

interface CandidateMatch {
  transactionId: string;
  receiptId: string;
  confidence: MatchConfidence;
  amountDiff: number;
  daysDiff: number;
  compositeScore: number;
  overridesExisting: boolean;
  categoryId?: string;
}

interface ReceiptRecord {
  id: string;
  totalAmount: number;
  date: string;
  vendorName: string;
}

interface PhaseResult {
  matches: CandidateMatch[];
  unmatchedReceipts: ReceiptRecord[];
  unmatchedTransactions: Transaction[];
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

/**
 * Jaro-Winkler similarity for fuzzy vendor matching.
 * Returns a value between 0 (no match) and 1 (identical).
 */
function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchWindow = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

  // Winkler prefix bonus (up to 4 chars)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Compute a vendor similarity score between 0 and 1.
 * Uses substring match first, then Jaro-Winkler as fallback.
 */
function vendorScore(
  vendorName: string,
  payee: string | undefined,
  importedPayee: string | undefined,
): number {
  if (!vendorName) return 0;
  const normalizedVendor = normalizeVendor(vendorName);
  if (!normalizedVendor) return 0;

  const candidates = [payee, importedPayee].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
  if (candidates.length === 0) return 0;

  let bestScore = 0;
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeVendor(candidate);
    if (!normalizedCandidate) continue;

    // Exact normalized match
    if (normalizedCandidate === normalizedVendor) {
      return 1.0;
    }

    // Bidirectional substring
    if (normalizedCandidate.includes(normalizedVendor) || normalizedVendor.includes(normalizedCandidate)) {
      bestScore = Math.max(bestScore, 0.85);
      continue;
    }

    // Jaro-Winkler fuzzy match
    const jw = jaroWinkler(normalizedVendor, normalizedCandidate);
    if (jw >= 0.85) {
      bestScore = Math.max(bestScore, jw * 0.8); // scale down: 0.85 JW → 0.68 score
    }
  }

  return bestScore;
}

/**
 * Compute date score: 0 (no match) to 1 (same day).
 */
function dateScore(days: number): number {
  if (!Number.isFinite(days)) return 0;
  if (days <= 1) return 1.0;
  if (days <= 3) return 0.80;
  if (days <= 7) return 0.50;
  if (days <= 14) return 0.20;
  if (days <= 30) return 0.05;
  return 0;
}

/**
 * Compute amount score: 0 (no match) to 1 (exact penny).
 */
function amountScore(amountDiff: number, toleranceCents: number): number {
  if (amountDiff === 0) return 1.0;
  if (amountDiff <= 1) return 0.98;
  if (amountDiff <= toleranceCents) return 0.90;
  return 0;
}

class MatchingService {
  private store: ReceiptStore;
  private toleranceCents: number;
  private toleranceDays: number;
  private autoMatch: boolean;
  private structuralToleranceDays: number;
  private maxDateGapDays: number;
  private fuzzyMatchThreshold: number;

  constructor(
    store: ReceiptStore,
    toleranceCents: number,
    toleranceDays: number,
    autoMatch: boolean,
    structuralToleranceDays = 3,
    maxDateGapDays = 30,
    fuzzyMatchThreshold = 0.50,
  ) {
    this.store = store;
    this.toleranceCents = toleranceCents;
    this.toleranceDays = toleranceDays;
    this.autoMatch = autoMatch;
    this.structuralToleranceDays = structuralToleranceDays;
    this.maxDateGapDays = maxDateGapDays;
    this.fuzzyMatchThreshold = fuzzyMatchThreshold;
  }

  matchAll(transactions: Transaction[]): MatchSummary {
    const rawUnmatched = this.store.getUnmatchedReceipts();

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

    // Normalize receipt records
    const unmatchedReceipts: ReceiptRecord[] = rawUnmatched
      .filter((r) => (r.totalAmount as number) !== 0)
      .map((r) => ({
        id: r.id as string,
        totalAmount: r.totalAmount as number,
        date: r.date as string,
        vendorName: (r.vendorName as string) ?? '',
      }));

    const summary: MatchSummary = {
      matched: 0, exact: 0, probable: 0, possible: 0, unmatched: 0,
      phase1Matched: 0, phase2Matched: 0, phase3Matched: 0,
    };

    if (unmatchedReceipts.length === 0 || availableTransactions.length === 0) {
      summary.unmatched = unmatchedReceipts.length;
      return summary;
    }

    // Phase 1: Exact Match (amount + date + vendor, tight tolerances)
    const phase1 = this.phaseExactMatch(unmatchedReceipts, availableTransactions);
    this.commitMatches(phase1.matches, summary);
    summary.phase1Matched = phase1.matches.length;

    // Phase 2: Structural Match (vendor+amount groups, chronological ordering)
    const phase2 = this.phaseStructuralMatch(phase1.unmatchedReceipts, phase1.unmatchedTransactions);
    this.commitMatches(phase2.matches, summary);
    summary.phase2Matched = phase2.matches.length;

    // Phase 3: Fuzzy Match (scored assignment for remaining)
    const phase3 = this.phaseFuzzyMatch(phase2.unmatchedReceipts, phase2.unmatchedTransactions);
    this.commitMatches(phase3.matches, summary);
    summary.phase3Matched = phase3.matches.length;

    summary.unmatched = unmatchedReceipts.length - summary.matched;

    console.log(
      `Receipt matching complete: ${summary.matched} matched `
      + `(${summary.exact} exact, ${summary.probable} probable, ${summary.possible} possible) `
      + `[P1:${summary.phase1Matched} P2:${summary.phase2Matched} P3:${summary.phase3Matched}], `
      + `${summary.unmatched} unmatched`,
    );

    return summary;
  }

  /**
   * Phase 1: Exact Match — all three signals must agree (tight tolerances).
   * Builds all qualifying pairs, sorts by score, greedy assigns.
   */
  private phaseExactMatch(receipts: ReceiptRecord[], transactions: Transaction[]): PhaseResult {
    const pairs: CandidateMatch[] = [];

    for (const receipt of receipts) {
      for (const tx of transactions) {
        const amountDiff = Math.abs(receipt.totalAmount - Math.abs(tx.amount));
        if (amountDiff > this.toleranceCents) continue;

        const days = daysBetween(receipt.date, tx.date);
        if (days > this.toleranceDays) continue;

        if (!vendorMatch(receipt.vendorName, tx.payee, tx.imported_payee)) continue;

        // All three signals agree → exact match candidate
        pairs.push({
          transactionId: tx.id,
          receiptId: receipt.id,
          confidence: 'exact',
          amountDiff,
          daysDiff: days,
          compositeScore: (1 / (1 + amountDiff)) * (1 / (1 + days)),
          overridesExisting: !!tx.hasCategory,
          categoryId: tx.categoryId,
        });
      }
    }

    return this.greedyAssign(pairs, receipts, transactions);
  }

  /**
   * Phase 2: Structural Match — group by vendor+amount, match chronologically.
   * Solves the "daily Arby's" problem using two-pointer sweep within groups.
   */
  private phaseStructuralMatch(receipts: ReceiptRecord[], transactions: Transaction[]): PhaseResult {
    const matches: CandidateMatch[] = [];
    const matchedReceiptIds = new Set<string>();
    const matchedTxIds = new Set<string>();

    // Group receipts by (normalizedVendor, roundedAmount)
    const receiptGroups = new Map<string, ReceiptRecord[]>();
    for (const receipt of receipts) {
      const nv = normalizeVendor(receipt.vendorName);
      if (!nv) continue;
      const roundedAmt = Math.round(receipt.totalAmount / Math.max(this.toleranceCents, 1)) * Math.max(this.toleranceCents, 1);
      const key = `${nv}|${roundedAmt}`;
      const group = receiptGroups.get(key) ?? [];
      group.push(receipt);
      receiptGroups.set(key, group);
    }

    for (const [, groupReceipts] of receiptGroups) {
      if (groupReceipts.length < 2) continue; // Single receipts handled by Phase 3

      // Find transactions matching this vendor+amount group
      const groupTxs: Transaction[] = [];
      for (const tx of transactions) {
        if (matchedTxIds.has(tx.id)) continue;
        const sample = groupReceipts[0];
        const amountDiff = Math.abs(sample.totalAmount - Math.abs(tx.amount));
        if (amountDiff > this.toleranceCents) continue;
        if (!vendorMatch(sample.vendorName, tx.payee, tx.imported_payee)) continue;
        groupTxs.push(tx);
      }

      if (groupTxs.length === 0) continue;

      // Sort both by date ascending
      const sortedReceipts = [...groupReceipts]
        .filter((r) => !matchedReceiptIds.has(r.id))
        .sort((a, b) => a.date.localeCompare(b.date));
      const sortedTxs = [...groupTxs].sort((a, b) => {
        const da = parseDate(a.date).getTime();
        const db = parseDate(b.date).getTime();
        return da - db;
      });

      // Two-pointer sweep
      let ri = 0;
      let ti = 0;
      while (ri < sortedReceipts.length && ti < sortedTxs.length) {
        const receipt = sortedReceipts[ri];
        const tx = sortedTxs[ti];

        if (matchedReceiptIds.has(receipt.id)) { ri++; continue; }
        if (matchedTxIds.has(tx.id)) { ti++; continue; }

        const days = daysBetween(receipt.date, tx.date);
        const receiptTime = parseDate(receipt.date).getTime();
        const txTime = parseDate(tx.date).getTime();

        if (days <= this.structuralToleranceDays) {
          // Match them
          const amountDiff = Math.abs(receipt.totalAmount - Math.abs(tx.amount));
          matches.push({
            transactionId: tx.id,
            receiptId: receipt.id,
            confidence: 'probable',
            amountDiff,
            daysDiff: days,
            compositeScore: (1 / (1 + amountDiff)) * (1 / (1 + days)),
            overridesExisting: !!tx.hasCategory,
            categoryId: tx.categoryId,
          });
          matchedReceiptIds.add(receipt.id);
          matchedTxIds.add(tx.id);
          ri++;
          ti++;
        } else if (receiptTime < txTime) {
          // Receipt is too early — no tx for it in this group
          ri++;
        } else {
          // Transaction is too early — no receipt for it in this group
          ti++;
        }
      }
    }

    const unmatchedReceipts = receipts.filter((r) => !matchedReceiptIds.has(r.id));
    const unmatchedTransactions = transactions.filter((t) => !matchedTxIds.has(t.id));

    return { matches, unmatchedReceipts, unmatchedTransactions };
  }

  /**
   * Phase 3: Fuzzy Match — score all remaining pairs and greedy-assign.
   * Uses composite scoring (amount 50%, date 30%, vendor 20%) with hard date cap.
   */
  private phaseFuzzyMatch(receipts: ReceiptRecord[], transactions: Transaction[]): PhaseResult {
    const pairs: CandidateMatch[] = [];

    for (const receipt of receipts) {
      for (const tx of transactions) {
        const amountDiff = Math.abs(receipt.totalAmount - Math.abs(tx.amount));
        const aScore = amountScore(amountDiff, this.toleranceCents);
        if (aScore === 0) continue;

        const days = daysBetween(receipt.date, tx.date);
        // Hard date cap — no match beyond maxDateGapDays
        if (days > this.maxDateGapDays) continue;

        const dScore = dateScore(days);
        const vScore = vendorScore(receipt.vendorName, tx.payee, tx.imported_payee);

        const composite = 0.50 * aScore + 0.30 * dScore + 0.20 * vScore;
        if (composite < this.fuzzyMatchThreshold) continue;

        // Determine confidence based on signals present
        let confidence: MatchConfidence;
        const hasDate = days <= this.structuralToleranceDays;
        const hasVendor = vScore >= 0.85;
        if (hasDate && hasVendor) {
          confidence = 'exact';
        } else if (hasDate || hasVendor) {
          confidence = 'probable';
        } else {
          confidence = 'possible';
        }

        pairs.push({
          transactionId: tx.id,
          receiptId: receipt.id,
          confidence,
          amountDiff,
          daysDiff: days,
          compositeScore: composite,
          overridesExisting: !!tx.hasCategory,
          categoryId: tx.categoryId,
        });
      }
    }

    return this.greedyAssign(pairs, receipts, transactions);
  }

  /**
   * Greedy assignment: sort pairs by score descending, assign highest first,
   * removing both receipt and transaction from the pool after each assignment.
   */
  private greedyAssign(
    pairs: CandidateMatch[],
    receipts: ReceiptRecord[],
    transactions: Transaction[],
  ): PhaseResult {
    // Sort: highest composite score first; break ties by amountDiff, then daysDiff
    pairs.sort((a, b) => {
      if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
      if (a.amountDiff !== b.amountDiff) return a.amountDiff - b.amountDiff;
      return a.daysDiff - b.daysDiff;
    });

    const matchedReceiptIds = new Set<string>();
    const matchedTxIds = new Set<string>();
    const matches: CandidateMatch[] = [];

    for (const pair of pairs) {
      if (matchedReceiptIds.has(pair.receiptId)) continue;
      if (matchedTxIds.has(pair.transactionId)) continue;

      matches.push(pair);
      matchedReceiptIds.add(pair.receiptId);
      matchedTxIds.add(pair.transactionId);
    }

    const unmatchedReceipts = receipts.filter((r) => !matchedReceiptIds.has(r.id));
    const unmatchedTransactions = transactions.filter((t) => !matchedTxIds.has(t.id));

    return { matches, unmatchedReceipts, unmatchedTransactions };
  }

  /**
   * Commit matches to the store and update summary counters.
   */
  private commitMatches(matches: CandidateMatch[], summary: MatchSummary): void {
    for (const candidate of matches) {
      this.store.createMatch(
        candidate.transactionId,
        candidate.receiptId,
        candidate.confidence,
        candidate.overridesExisting,
        candidate.categoryId,
      );

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
  }

  unmatch(matchId: string): void {
    const match = this.store.getMatch(matchId);
    if (!match) {
      throw new Error(`Match not found: ${matchId}`);
    }

    if (match.status === 'applied' && match.preSplitSnapshot) {
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
