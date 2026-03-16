import ActualApiService from '../actual-api-service';
import ReceiptStore from './receipt-store';
import buildSplitPlan from './split-plan-builder';

/** Append a tag to a notes string if it is not already present. */
function appendTag(notes: string, tag: string): string {
  if (notes.includes(tag)) return notes;
  const trimmed = notes.trim();
  return trimmed.length > 0 ? `${trimmed} ${tag}` : tag;
}

/** Remove a tag from a notes string. */
function removeTag(notes: string, tag: string): string {
  return notes
    .split(tag)
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

interface AdditionalCharge {
  type: string;
  amount: number;
  categoryId?: string;
}

class SplitTransactionService {
  private actualApiService: ActualApiService;

  private store: ReceiptStore;

  private receiptTag: string;

  constructor(
    actualApiService: ActualApiService,
    store: ReceiptStore,
    receiptTag: string,
  ) {
    this.actualApiService = actualApiService;
    this.store = store;
    this.receiptTag = receiptTag;
  }

  async applySplit(matchId: string): Promise<void> {
    // 1. Get the match and verify status
    const match = this.store.getMatch(matchId);
    if (!match) {
      throw new Error(`Match not found: ${matchId}`);
    }
    if (match.status !== 'approved') {
      throw new Error(
        `Cannot apply split: match ${matchId} status is '${String(match.status)}', expected 'approved'`,
      );
    }

    // 2. Get the receipt
    const receipt = this.store.getReceipt(match.receiptId as string);
    if (!receipt) {
      throw new Error(`Receipt not found for match ${matchId}: ${String(match.receiptId)}`);
    }

    // 3. Get the original transaction from Actual Budget
    const transaction = await this.actualApiService.getTransactionById(
      match.transactionId as string,
    );
    if (!transaction) {
      throw new Error(
        `Transaction not found in Actual Budget: ${String(match.transactionId)}`,
      );
    }

    // 5. Safeguards
    if ((transaction as Record<string, unknown>).is_parent === true) {
      throw new Error('Cannot split an already-split transaction');
    }
    if (transaction.reconciled === true) {
      throw new Error(
        'Cannot split a reconciled transaction without user confirmation',
      );
    }

    // 6. Snapshot the transaction before modifying
    this.store.setPreSplitSnapshot(matchId, JSON.stringify(transaction));

    // 7. Get approved classifications
    const allClassifications = this.store.getClassificationsForMatch(matchId);
    const approvedClassifications = allClassifications.filter(
      (c) => c.status === 'approved',
    );

    // 8. Single-item shortcut: just update category instead of splitting
    if (approvedClassifications.length === 1) {
      const cls = approvedClassifications[0];
      const categoryId = cls.suggestedCategoryId as string | undefined;
      const taggedNotes = appendTag(
        transaction.notes ?? '', this.receiptTag,
      );
      if (categoryId) {
        await this.actualApiService.updateTransactionNotesAndCategory(
          transaction.id, taggedNotes, categoryId,
        );
      } else {
        await this.actualApiService.updateTransactionNotes(
          transaction.id, taggedNotes,
        );
      }
      this.store.updateMatchStatus(matchId, 'applied');
      console.log(
        `Applied category for match ${matchId}: single line item`
        + ` → ${String(cls.suggestedCategoryName ?? 'uncategorized')}`,
      );
      return;
    }

    // 9. Build additional charges from receipt data
    const additionalCharges = extractAdditionalCharges(receipt);

    // 10. Build the split plan
    const plan = buildSplitPlan(
      match.transactionId as string,
      approvedClassifications.map((c) => ({
        amountWithTax: c.amountWithTax as number,
        suggestedCategoryId: (c.suggestedCategoryId as string) ?? null,
        description: c.description as string,
        status: c.status as string,
      })),
      additionalCharges,
      transaction.amount,
    );

    // 11. Delete the original transaction
    await this.actualApiService.deleteTransaction(transaction.id);

    // 12. Re-create via import with subtransactions
    await this.actualApiService.importTransactionsWithSplits(
      transaction.account,
      [
        {
          date: transaction.date,
          payee_name: (transaction as Record<string, unknown>).payee_name as
            | string
            | undefined,
          imported_payee: transaction.imported_payee,
          notes: appendTag(transaction.notes ?? '', this.receiptTag),
          amount: transaction.amount,
          cleared: transaction.cleared,
          subtransactions: plan.splits.map((s) => ({
            amount: s.amount,
            category: s.categoryId,
            notes: s.notes,
          })),
        },
      ],
    );

    // 13. Update match status
    this.store.updateMatchStatus(matchId, 'applied');

    // 14. Log
    console.log(
      `Applied split for match ${matchId}: ${plan.splits.length} subtransactions`,
    );
  }

  async rollbackSplit(matchId: string): Promise<void> {
    // 1. Get match and verify status
    const match = this.store.getMatch(matchId);
    if (!match) {
      throw new Error(`Match not found: ${matchId}`);
    }
    if (match.status !== 'applied') {
      throw new Error(
        `Cannot rollback split: match ${matchId} status is '${String(match.status)}', expected 'applied'`,
      );
    }

    // 2. Get pre-split snapshot
    const snapshotJson = match.preSplitSnapshot as string | undefined;
    if (!snapshotJson) {
      throw new Error('No pre-split snapshot available');
    }

    // 3. Parse snapshot
    const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;

    // 4. Delete the current (split) transaction
    await this.actualApiService.deleteTransaction(
      match.transactionId as string,
    );

    // 5-6. Re-create original from snapshot, removing the receipt tag from notes
    const originalNotes = removeTag(
      (snapshot.notes as string) ?? '',
      this.receiptTag,
    );

    await this.actualApiService.importTransactionsWithSplits(
      snapshot.account as string,
      [
        {
          date: snapshot.date as string,
          payee_name: snapshot.payee_name as string | undefined,
          imported_payee: snapshot.imported_payee as string | undefined,
          notes: originalNotes,
          amount: snapshot.amount as number,
          cleared: snapshot.cleared as boolean | undefined,
          subtransactions: [], // no subtransactions — restore as a flat transaction
        },
      ],
    );

    // 7. Update match status back to approved
    this.store.updateMatchStatus(matchId, 'approved');

    // 8. Log
    console.log(`Rolled back split for match ${matchId}`);
  }
}

/**
 * Extract tip, shipping, and other additional charges from receipt data.
 * The receipt row stores the full ReceiptDocument as JSON in receiptData.
 */
function extractAdditionalCharges(
  receipt: Record<string, unknown>,
): AdditionalCharge[] {
  const charges: AdditionalCharge[] = [];

  let parsed: Record<string, unknown> | null = null;
  if (typeof receipt.receiptData === 'string') {
    try {
      parsed = JSON.parse(receipt.receiptData) as Record<string, unknown>;
    } catch {
      // If receiptData is not valid JSON, fall back to receipt-level fields
      parsed = null;
    }
  }

  // Prefer parsed receiptData (full ReceiptDocument), fall back to top-level fields
  const source = parsed ?? receipt;

  const tipAmount = asNumberOrZero(source.tipAmount);
  if (tipAmount > 0) {
    charges.push({ type: 'tip', amount: tipAmount });
  }

  const shippingAmount = asNumberOrZero(source.shippingAmount);
  if (shippingAmount > 0) {
    charges.push({ type: 'shipping', amount: shippingAmount });
  }

  // Some providers report a generic "fee" or "service charge" in discountAmount
  // as a negative discount. We only add positive fees.
  // Note: discountAmount on the receipt is already factored into line item prices
  // by the OCR provider, so we do not create a separate split for it.

  return charges;
}

/** Safely coerce a value to a non-negative integer, defaulting to 0. */
function asNumberOrZero(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return 0;
}

export default SplitTransactionService;
