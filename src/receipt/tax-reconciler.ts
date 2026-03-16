import ReceiptStore from './receipt-store';
import allocateTax, { validateReceiptBalance } from './tax-allocator';
import { ReceiptDocument } from './types';

function toSqliteBool(val: boolean | null): number | null {
  if (val == null) return null;
  return val ? 1 : 0;
}

/**
 * Standalone tax reconciliation: re-infers taxability from current category
 * names using the DB-backed tax_exempt_categories table, re-allocates tax,
 * and updates all classification rows for the given match.
 *
 * Returns the refreshed classifications array (post-update).
 */
// eslint-disable-next-line import/prefer-default-export
export function reconcileMatchTax(
  store: ReceiptStore,
  matchId: string,
): Record<string, unknown>[] {
  const classifications = store.getClassificationsForMatch(matchId);
  if (classifications.length === 0) return classifications;

  // Look up receipt for tax amount and additional charges
  const match = store.getMatch(matchId);
  if (!match) return classifications;
  const receiptRow = store.getReceipt(match.receiptId as string);
  if (!receiptRow) return classifications;

  let receipt: ReceiptDocument;
  try {
    receipt = JSON.parse(receiptRow.receiptData as string) as ReceiptDocument;
  } catch {
    return classifications;
  }

  // Infer taxability from category names via DB prefixes
  const inferredTaxable = classifications.map((c) => {
    const name = c.suggestedCategoryName as string | null;
    if (!name) return null;
    return !store.isCategoryTaxExempt(name);
  });

  const hasAnyTaxable = inferredTaxable.some((t) => t === true);
  const taxableFlags = (receipt.taxAmount !== 0 && !hasAnyTaxable)
    ? classifications.map(() => null)
    : inferredTaxable;

  // Allocate tax
  const taxInput = {
    lineItems: classifications.map((c, i) => ({
      totalPrice: c.totalPrice as number,
      taxable: taxableFlags[i],
    })),
    totalTax: receipt.taxAmount,
  };
  const taxResult = allocateTax(taxInput);

  // Balance check + adjustment
  const lineItemAmounts = taxResult.allocations.map((a) => a.amountWithTax);
  const extraCharges = (receipt.tipAmount ?? 0) + (receipt.shippingAmount ?? 0);
  const balance = validateReceiptBalance(
    lineItemAmounts,
    extraCharges,
    receipt.totalAmount,
  );

  if (!balance.balanced) {
    let largestIdx = 0;
    let largestAbs = 0;
    for (let i = 0; i < lineItemAmounts.length; i++) {
      const abs = Math.abs(lineItemAmounts[i]);
      if (abs > largestAbs) { largestAbs = abs; largestIdx = i; }
    }
    taxResult.allocations[largestIdx].amountWithTax += balance.discrepancy;
    taxResult.allocations[largestIdx].allocatedTax += balance.discrepancy;
  }

  // Update stored classifications with corrected tax
  for (let i = 0; i < classifications.length; i++) {
    const c = classifications[i];
    const alloc = taxResult.allocations[i];
    if (c.allocatedTax !== alloc.allocatedTax
      || c.amountWithTax !== alloc.amountWithTax
      || c.taxable !== toSqliteBool(taxableFlags[i])) {
      store.updateLineItemClassification(c.id as string, {
        allocatedTax: alloc.allocatedTax,
        amountWithTax: alloc.amountWithTax,
        taxable: taxableFlags[i],
      });
    }
  }

  // Return refreshed data
  return store.getClassificationsForMatch(matchId);
}
