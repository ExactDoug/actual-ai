import { RuleDescription } from '../types';
import LineItemClassifier from './line-item-classifier';
import MatchingService from './matching-service';
import ReceiptStore from './receipt-store';
import SplitTransactionService from './split-transaction-service';

interface BatchFilter {
  status?: string | string[];
  confidence?: string | string[];
  overridesExisting?: boolean;
  vendor?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
}

interface BatchRequest {
  matchIds?: string[];
  filter?: BatchFilter;
  limit?: number;
}

interface BatchResponse {
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ matchId: string; error: string }>;
}

interface CategoryInfo {
  id: string;
  name: string;
  group?: string;
}

interface CategoryGroupInfo {
  id: string;
  name: string;
  categories: Array<{ id: string; name: string }>;
}

class BatchService {
  private readonly store: ReceiptStore;

  private readonly classifier: LineItemClassifier;

  private readonly splitService: SplitTransactionService;

  private readonly matchingService: MatchingService;

  constructor(
    store: ReceiptStore,
    classifier: LineItemClassifier,
    splitService: SplitTransactionService,
    matchingService: MatchingService,
  ) {
    this.store = store;
    this.classifier = classifier;
    this.splitService = splitService;
    this.matchingService = matchingService;
  }

  /**
   * Resolve a batch request to an array of match IDs.
   */
  private resolveMatchIds(request: BatchRequest): string[] {
    if (request.matchIds && request.matchIds.length > 0) {
      const limit = Math.min(request.limit ?? 50, 200);
      return request.matchIds.slice(0, limit);
    }
    if (request.filter) {
      const matches = this.store.getMatchesByFilter(request.filter, request.limit ?? 50);
      return matches.map((m) => m.id as string);
    }
    return [];
  }

  /**
   * Classify multiple matched receipts.
   */
  async batchClassify(
    request: BatchRequest,
    categories: CategoryInfo[],
    categoryGroups: CategoryGroupInfo[],
    rules?: RuleDescription[],
  ): Promise<BatchResponse> {
    const matchIds = this.resolveMatchIds(request);
    const result: BatchResponse = { processed: matchIds.length, succeeded: 0, failed: 0, errors: [] };

    for (const matchId of matchIds) {
      try {
        await this.classifier.classifyReceipt(matchId, categories, categoryGroups, rules);
        result.succeeded++;
      } catch (err) {
        result.failed++;
        result.errors.push({ matchId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    console.log(`Batch classify: ${result.succeeded}/${result.processed} succeeded`);
    return result;
  }

  /**
   * Approve line items across multiple matches.
   */
  batchApprove(request: BatchRequest): BatchResponse {
    const matchIds = this.resolveMatchIds(request);
    const result: BatchResponse = { processed: matchIds.length, succeeded: 0, failed: 0, errors: [] };

    for (const matchId of matchIds) {
      try {
        const match = this.store.getMatch(matchId);
        if (!match) {
          result.failed++;
          result.errors.push({ matchId, error: 'Match not found' });
          continue;
        }
        if (match.status !== 'classified') {
          result.failed++;
          result.errors.push({ matchId, error: `Cannot approve match with status "${match.status}"` });
          continue;
        }
        const classifications = this.store.getClassificationsForMatch(matchId);
        for (const cls of classifications) {
          this.store.updateLineItemStatus(cls.id as string, 'approved');
        }
        this.store.updateMatchStatus(matchId, 'approved');
        result.succeeded++;
      } catch (err) {
        result.failed++;
        result.errors.push({ matchId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    console.log(`Batch approve: ${result.succeeded}/${result.processed} succeeded`);
    return result;
  }

  /**
   * Apply splits for multiple approved matches.
   */
  async batchApply(request: BatchRequest): Promise<BatchResponse> {
    const matchIds = this.resolveMatchIds(request);
    const result: BatchResponse = { processed: matchIds.length, succeeded: 0, failed: 0, errors: [] };

    for (const matchId of matchIds) {
      try {
        await this.splitService.applySplit(matchId);
        result.succeeded++;
      } catch (err) {
        result.failed++;
        result.errors.push({ matchId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    console.log(`Batch apply: ${result.succeeded}/${result.processed} succeeded`);
    return result;
  }

  /**
   * Unmatch multiple matches.
   */
  batchUnmatch(request: BatchRequest): BatchResponse {
    const matchIds = this.resolveMatchIds(request);
    const result: BatchResponse = { processed: matchIds.length, succeeded: 0, failed: 0, errors: [] };

    for (const matchId of matchIds) {
      try {
        this.matchingService.unmatch(matchId);
        result.succeeded++;
      } catch (err) {
        result.failed++;
        result.errors.push({ matchId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    console.log(`Batch unmatch: ${result.succeeded}/${result.processed} succeeded`);
    return result;
  }

  /**
   * Reject multiple matches.
   */
  batchReject(request: BatchRequest): BatchResponse {
    const matchIds = this.resolveMatchIds(request);
    const result: BatchResponse = { processed: matchIds.length, succeeded: 0, failed: 0, errors: [] };

    for (const matchId of matchIds) {
      try {
        const match = this.store.getMatch(matchId);
        if (!match) {
          result.failed++;
          result.errors.push({ matchId, error: 'Match not found' });
          continue;
        }
        if (match.status === 'applied') {
          result.failed++;
          result.errors.push({ matchId, error: 'Cannot reject an applied match — rollback first' });
          continue;
        }
        // Reject all line item classifications
        const classifications = this.store.getClassificationsForMatch(matchId);
        for (const cls of classifications) {
          this.store.updateLineItemStatus(cls.id as string, 'rejected');
        }
        this.store.updateMatchStatus(matchId, 'rejected');
        result.succeeded++;
      } catch (err) {
        result.failed++;
        result.errors.push({ matchId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    console.log(`Batch reject: ${result.succeeded}/${result.processed} succeeded`);
    return result;
  }

  /**
   * Reset all non-applied matches and return stats for the caller to trigger rematch.
   * Applied matches with a preSplitSnapshot are preserved (they modified Actual Budget
   * and require explicit rollback). Applied matches without snapshot (kept) are reset.
   */
  resetForRematch(): {
    reset: number;
    preserved: number;
    errors: Array<{ matchId: string; error: string }>;
  } {
    const resettable = this.store.getAllResettableMatches();
    const preserved = this.store.getAppliedWithSnapshotCount();
    const errors: Array<{ matchId: string; error: string }> = [];
    let reset = 0;

    for (const match of resettable) {
      try {
        this.matchingService.unmatch(match.id as string);
        reset++;
      } catch (err) {
        errors.push({
          matchId: match.id as string,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    console.log(`Reset for rematch: ${reset} reset, ${preserved} preserved (applied with snapshot), ${errors.length} errors`);
    return { reset, preserved, errors };
  }

  /**
   * Re-classify already-classified matches.
   * Delegates to batchClassify — the classifier now supports re-classification
   * on 'classified' and 'rejected' matches.
   */
  async batchReclassify(
    request: BatchRequest,
    categories: CategoryInfo[],
    categoryGroups: CategoryGroupInfo[],
    rules?: RuleDescription[],
  ): Promise<BatchResponse> {
    return this.batchClassify(request, categories, categoryGroups, rules);
  }
}

export type { BatchRequest, BatchResponse, BatchFilter };
export default BatchService;
