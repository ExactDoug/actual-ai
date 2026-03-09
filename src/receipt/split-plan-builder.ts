import { SplitPlan, SplitEntry } from './types';

interface ClassificationInput {
  amountWithTax: number;           // cents (positive)
  suggestedCategoryId: string | null;
  description: string;
  status: string;                  // only 'approved' items are included
}

interface AdditionalCharge {
  type: string;                    // tip, shipping, fee
  amount: number;                  // cents (positive)
  categoryId?: string;
}

/**
 * Build a SplitPlan from approved line-item classifications and additional
 * charges, ensuring the sum of splits equals the original transaction amount.
 *
 * Actual Budget uses negative amounts for expenses. The classifications store
 * amounts as positive cents. The originalTransactionAmount from Actual Budget
 * is negative for expenses.
 */
export default function buildSplitPlan(
  transactionId: string,
  classifications: ClassificationInput[],
  additionalCharges: AdditionalCharge[],
  originalTransactionAmount: number, // cents (negative for expenses)
): SplitPlan {
  // Step 1: filter to only approved classifications that have a category
  const approved = classifications.filter(
    (c) => c.status === 'approved' && c.suggestedCategoryId != null,
  );

  // Step 2: build SplitEntry for each approved classification
  // Amounts are stored as positive cents in classifications; Actual Budget
  // uses negative amounts for expenses, so negate them.
  const splits: SplitEntry[] = approved.map((c) => ({
    amount: -c.amountWithTax,
    categoryId: c.suggestedCategoryId!,
    notes: c.description,
  }));

  // Step 3: determine the fallback category for charges without one.
  // Use the most common categoryId among the line-item splits.
  const fallbackCategoryId = getMostCommonCategory(splits);

  for (const charge of additionalCharges) {
    if (charge.amount === 0) continue;

    const categoryId = charge.categoryId ?? fallbackCategoryId;
    if (!categoryId) continue; // skip if we have no category at all

    splits.push({
      amount: -charge.amount,
      categoryId,
      notes: charge.type,
    });
  }

  // Step 4: compare the sum of all splits to the original transaction amount
  const splitSum = splits.reduce((sum, s) => sum + s.amount, 0);
  const roundingDiff = originalTransactionAmount - splitSum;

  // Step 5: adjust the largest-absolute-amount split for any rounding difference
  if (roundingDiff !== 0 && splits.length > 0) {
    const largestIdx = indexOfLargestAbsAmount(splits);
    splits[largestIdx].amount += roundingDiff;
  }

  return { transactionId, splits };
}

/** Return the categoryId that appears most frequently among splits. */
function getMostCommonCategory(splits: SplitEntry[]): string | undefined {
  if (splits.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const s of splits) {
    counts.set(s.categoryId, (counts.get(s.categoryId) ?? 0) + 1);
  }

  let bestId: string | undefined;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestId = id;
    }
  }
  return bestId;
}

/** Return the index of the split with the largest Math.abs(amount). */
function indexOfLargestAbsAmount(splits: SplitEntry[]): number {
  let maxIdx = 0;
  let maxAbs = Math.abs(splits[0].amount);

  for (let i = 1; i < splits.length; i++) {
    const abs = Math.abs(splits[i].amount);
    if (abs > maxAbs) {
      maxAbs = abs;
      maxIdx = i;
    }
  }

  return maxIdx;
}
