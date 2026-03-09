// Tax allocation — distributes receipt-level tax across individual line items.
// All monetary amounts are integers in cents (Actual Budget convention).

interface TaxAllocationInput {
  lineItems: Array<{
    totalPrice: number;   // cents, after discount
    taxable: boolean | null;
  }>;
  totalTax: number;       // cents
}

interface TaxAllocationResult {
  allocations: Array<{
    allocatedTax: number;     // cents
    amountWithTax: number;    // cents
  }>;
  adjustment: number;         // rounding adjustment applied (cents)
}

/**
 * Distribute total tax across line items using taxable indicators when
 * available, falling back to proportional allocation by price.
 *
 * Algorithm (spec Section 5.2):
 *  1. Zero tax → every item gets 0 tax.
 *  2. If any item has an explicit taxable flag (not null):
 *     - Allocate tax proportionally among taxable items only.
 *     - If taxable total is 0, fall through to proportional.
 *  3. Proportional allocation across all items by totalPrice.
 *  4. Rounding adjustment: any remainder goes to the largest-abs-price item.
 *  5. amountWithTax = totalPrice + allocatedTax.
 */
export default function allocateTax(input: TaxAllocationInput): TaxAllocationResult {
  const { lineItems, totalTax } = input;

  // Step 1: zero tax shortcut
  if (totalTax === 0) {
    return {
      allocations: lineItems.map((item) => ({
        allocatedTax: 0,
        amountWithTax: item.totalPrice,
      })),
      adjustment: 0,
    };
  }

  // Determine whether any item carries an explicit taxable indicator.
  const hasTaxableIndicator = lineItems.some((item) => item.taxable !== null);

  let rawAllocations: number[];

  if (hasTaxableIndicator) {
    const taxableTotal = lineItems.reduce(
      (sum, item) => (item.taxable === true ? sum + item.totalPrice : sum),
      0,
    );

    if (taxableTotal !== 0) {
      // Step 2: allocate only among taxable items
      rawAllocations = lineItems.map((item) =>
        item.taxable === true
          ? Math.round(totalTax * (item.totalPrice / taxableTotal))
          : 0,
      );
    } else {
      // taxableTotal is 0 — fall through to proportional
      rawAllocations = proportionalAllocate(lineItems, totalTax);
    }
  } else {
    // Step 3: proportional across all items
    rawAllocations = proportionalAllocate(lineItems, totalTax);
  }

  // Step 4: rounding adjustment
  const allocated = rawAllocations.reduce((a, b) => a + b, 0);
  let adjustment = totalTax - allocated;

  if (adjustment !== 0) {
    const largestIdx = indexOfLargestAbs(lineItems);
    if (largestIdx !== -1) {
      rawAllocations[largestIdx] += adjustment;
    }
  }

  // Step 5: build result
  const allocations = lineItems.map((item, i) => ({
    allocatedTax: rawAllocations[i],
    amountWithTax: item.totalPrice + rawAllocations[i],
  }));

  return { allocations, adjustment };
}

/** Proportional allocation across every item based on totalPrice. */
function proportionalAllocate(
  lineItems: Array<{ totalPrice: number }>,
  totalTax: number,
): number[] {
  const allItemsTotal = lineItems.reduce((sum, item) => sum + item.totalPrice, 0);

  if (allItemsTotal === 0) {
    return lineItems.map(() => 0);
  }

  return lineItems.map((item) =>
    Math.round(totalTax * (item.totalPrice / allItemsTotal)),
  );
}

/** Return the index of the item with the largest Math.abs(totalPrice), or -1 if empty. */
function indexOfLargestAbs(lineItems: Array<{ totalPrice: number }>): number {
  if (lineItems.length === 0) return -1;

  let maxIdx = 0;
  let maxAbs = Math.abs(lineItems[0].totalPrice);

  for (let i = 1; i < lineItems.length; i++) {
    const abs = Math.abs(lineItems[i].totalPrice);
    if (abs > maxAbs) {
      maxAbs = abs;
      maxIdx = i;
    }
  }

  return maxIdx;
}

/**
 * Check whether the line-item amounts plus additional charges equal the
 * expected receipt total. Pure validation — does not modify anything.
 */
export function validateReceiptBalance(
  lineItemAmounts: number[],   // amountWithTax for each item (cents)
  additionalCharges: number,   // tip + shipping + fee (cents)
  expectedTotal: number,       // receipt.totalAmount (cents)
): { balanced: boolean; discrepancy: number } {
  const actualTotal = lineItemAmounts.reduce((a, b) => a + b, 0) + additionalCharges;
  const discrepancy = expectedTotal - actualTotal;

  return {
    balanced: discrepancy === 0,
    discrepancy,
  };
}
