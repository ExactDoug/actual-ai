import allocateTax, { validateReceiptBalance } from '../src/receipt/tax-allocator';

describe('allocateTax', () => {
  it('should return zero tax for all items when totalTax is 0', () => {
    const result = allocateTax({
      lineItems: [
        { totalPrice: 500, taxable: null },
        { totalPrice: 300, taxable: null },
      ],
      totalTax: 0,
    });

    expect(result.allocations).toEqual([
      { allocatedTax: 0, amountWithTax: 500 },
      { allocatedTax: 0, amountWithTax: 300 },
    ]);
    expect(result.adjustment).toBe(0);
  });

  it('should allocate tax proportionally across all items when no taxable flags', () => {
    const result = allocateTax({
      lineItems: [
        { totalPrice: 600, taxable: null },
        { totalPrice: 400, taxable: null },
      ],
      totalTax: 100,
    });

    // 60% of 100 = 60, 40% of 100 = 40
    expect(result.allocations).toEqual([
      { allocatedTax: 60, amountWithTax: 660 },
      { allocatedTax: 40, amountWithTax: 440 },
    ]);
    expect(result.adjustment).toBe(0);
  });

  it('should allocate tax only to taxable items when flags are present', () => {
    const result = allocateTax({
      lineItems: [
        { totalPrice: 500, taxable: true },
        { totalPrice: 300, taxable: false },
        { totalPrice: 200, taxable: true },
      ],
      totalTax: 70,
    });

    // Taxable total = 500 + 200 = 700
    // Item 0: 70 * 500/700 = 50
    // Item 1: 0 (not taxable)
    // Item 2: 70 * 200/700 = 20
    expect(result.allocations[0].allocatedTax).toBe(50);
    expect(result.allocations[1].allocatedTax).toBe(0);
    expect(result.allocations[2].allocatedTax).toBe(20);

    expect(result.allocations[0].amountWithTax).toBe(550);
    expect(result.allocations[1].amountWithTax).toBe(300);
    expect(result.allocations[2].amountWithTax).toBe(220);
  });

  it('should fall through to proportional when taxable items total is 0', () => {
    const result = allocateTax({
      lineItems: [
        { totalPrice: 0, taxable: true },
        { totalPrice: 800, taxable: false },
      ],
      totalTax: 50,
    });

    // taxableTotal = 0, falls through to proportional across all
    // allItemsTotal = 800
    // Item 0: 50 * 0/800 = 0
    // Item 1: 50 * 800/800 = 50
    expect(result.allocations[0].allocatedTax).toBe(0);
    expect(result.allocations[1].allocatedTax).toBe(50);
  });

  it('should apply rounding adjustment to largest item', () => {
    const result = allocateTax({
      lineItems: [
        { totalPrice: 333, taxable: null },
        { totalPrice: 333, taxable: null },
        { totalPrice: 334, taxable: null },
      ],
      totalTax: 100,
    });

    const totalAllocated = result.allocations.reduce(
      (sum, a) => sum + a.allocatedTax, 0,
    );
    expect(totalAllocated).toBe(100);
    // The largest item (334) should get the rounding adjustment
    expect(result.allocations[2].allocatedTax).toBeGreaterThanOrEqual(33);
  });

  it('should handle single item', () => {
    const result = allocateTax({
      lineItems: [{ totalPrice: 1000, taxable: null }],
      totalTax: 80,
    });

    expect(result.allocations).toEqual([
      { allocatedTax: 80, amountWithTax: 1080 },
    ]);
    expect(result.adjustment).toBe(0);
  });

  it('should handle empty line items', () => {
    const result = allocateTax({
      lineItems: [],
      totalTax: 50,
    });

    expect(result.allocations).toEqual([]);
    // No items to adjust, adjustment stays as-is
  });

  it('should assign all tax to first item when all items have zero price', () => {
    const result = allocateTax({
      lineItems: [
        { totalPrice: 0, taxable: null },
        { totalPrice: 0, taxable: null },
      ],
      totalTax: 50,
    });

    // allItemsTotal = 0 → proportional gives all zeros → rounding adjustment
    // adds full tax to index 0 (first/largest-abs item)
    expect(result.allocations[0].allocatedTax).toBe(50);
    expect(result.allocations[1].allocatedTax).toBe(0);
    expect(result.adjustment).toBe(50);
  });

  it('should preserve total tax across many items with rounding', () => {
    const result = allocateTax({
      lineItems: [
        { totalPrice: 199, taxable: null },
        { totalPrice: 299, taxable: null },
        { totalPrice: 149, taxable: null },
        { totalPrice: 353, taxable: null },
      ],
      totalTax: 87,
    });

    const totalAllocated = result.allocations.reduce(
      (sum, a) => sum + a.allocatedTax, 0,
    );
    expect(totalAllocated).toBe(87);

    // amountWithTax should equal totalPrice + allocatedTax for each
    result.allocations.forEach((a, i) => {
      const items = [199, 299, 149, 353];
      expect(a.amountWithTax).toBe(items[i] + a.allocatedTax);
    });
  });
});

describe('validateReceiptBalance', () => {
  it('should report balanced when amounts match', () => {
    const result = validateReceiptBalance([500, 300, 200], 0, 1000);
    expect(result.balanced).toBe(true);
    expect(result.discrepancy).toBe(0);
  });

  it('should report balanced with additional charges', () => {
    const result = validateReceiptBalance([500, 300], 200, 1000);
    expect(result.balanced).toBe(true);
    expect(result.discrepancy).toBe(0);
  });

  it('should report discrepancy when unbalanced', () => {
    const result = validateReceiptBalance([500, 300], 0, 850);
    expect(result.balanced).toBe(false);
    expect(result.discrepancy).toBe(50);
  });

  it('should handle negative discrepancy', () => {
    const result = validateReceiptBalance([500, 400], 0, 800);
    expect(result.balanced).toBe(false);
    expect(result.discrepancy).toBe(-100);
  });

  it('should handle empty line items', () => {
    const result = validateReceiptBalance([], 100, 100);
    expect(result.balanced).toBe(true);
    expect(result.discrepancy).toBe(0);
  });
});
