import buildSplitPlan from '../src/receipt/split-plan-builder';

describe('buildSplitPlan', () => {
  it('should build splits from approved classifications', () => {
    const result = buildSplitPlan(
      'tx-1',
      [
        { amountWithTax: 500, suggestedCategoryId: 'cat-a', description: 'Item A', status: 'approved' },
        { amountWithTax: 300, suggestedCategoryId: 'cat-b', description: 'Item B', status: 'approved' },
      ],
      [],
      -800,
    );

    expect(result.transactionId).toBe('tx-1');
    expect(result.splits).toHaveLength(2);
    expect(result.splits[0]).toEqual({ amount: -500, categoryId: 'cat-a', notes: 'Item A' });
    expect(result.splits[1]).toEqual({ amount: -300, categoryId: 'cat-b', notes: 'Item B' });
  });

  it('should filter out non-approved classifications', () => {
    const result = buildSplitPlan(
      'tx-1',
      [
        { amountWithTax: 500, suggestedCategoryId: 'cat-a', description: 'Approved', status: 'approved' },
        { amountWithTax: 300, suggestedCategoryId: 'cat-b', description: 'Pending', status: 'pending' },
        { amountWithTax: 200, suggestedCategoryId: 'cat-c', description: 'Rejected', status: 'rejected' },
      ],
      [],
      -500,
    );

    expect(result.splits).toHaveLength(1);
    expect(result.splits[0].notes).toBe('Approved');
  });

  it('should filter out classifications without a category', () => {
    const result = buildSplitPlan(
      'tx-1',
      [
        { amountWithTax: 500, suggestedCategoryId: 'cat-a', description: 'With cat', status: 'approved' },
        { amountWithTax: 300, suggestedCategoryId: null, description: 'No cat', status: 'approved' },
      ],
      [],
      -500,
    );

    expect(result.splits).toHaveLength(1);
    expect(result.splits[0].notes).toBe('With cat');
  });

  it('should include additional charges with their own category', () => {
    const result = buildSplitPlan(
      'tx-1',
      [
        { amountWithTax: 500, suggestedCategoryId: 'cat-a', description: 'Item', status: 'approved' },
      ],
      [
        { type: 'tip', amount: 100, categoryId: 'cat-tip' },
      ],
      -600,
    );

    expect(result.splits).toHaveLength(2);
    expect(result.splits[1]).toEqual({ amount: -100, categoryId: 'cat-tip', notes: 'tip' });
  });

  it('should use most common category as fallback for charges without category', () => {
    const result = buildSplitPlan(
      'tx-1',
      [
        { amountWithTax: 500, suggestedCategoryId: 'cat-a', description: 'Item 1', status: 'approved' },
        { amountWithTax: 300, suggestedCategoryId: 'cat-a', description: 'Item 2', status: 'approved' },
        { amountWithTax: 200, suggestedCategoryId: 'cat-b', description: 'Item 3', status: 'approved' },
      ],
      [
        { type: 'shipping', amount: 50 },
      ],
      -1050,
    );

    expect(result.splits).toHaveLength(4);
    // Shipping should get cat-a (most common)
    expect(result.splits[3].categoryId).toBe('cat-a');
    expect(result.splits[3].notes).toBe('shipping');
  });

  it('should skip zero-amount additional charges', () => {
    const result = buildSplitPlan(
      'tx-1',
      [
        { amountWithTax: 500, suggestedCategoryId: 'cat-a', description: 'Item', status: 'approved' },
      ],
      [
        { type: 'tip', amount: 0, categoryId: 'cat-tip' },
      ],
      -500,
    );

    expect(result.splits).toHaveLength(1);
  });

  it('should adjust largest split for rounding difference', () => {
    const result = buildSplitPlan(
      'tx-1',
      [
        { amountWithTax: 333, suggestedCategoryId: 'cat-a', description: 'A', status: 'approved' },
        { amountWithTax: 333, suggestedCategoryId: 'cat-b', description: 'B', status: 'approved' },
        { amountWithTax: 333, suggestedCategoryId: 'cat-c', description: 'C', status: 'approved' },
      ],
      [],
      -1000, // original is -1000 but splits sum to -999
    );

    const splitSum = result.splits.reduce((sum, s) => sum + s.amount, 0);
    expect(splitSum).toBe(-1000);
  });

  it('should handle empty classifications', () => {
    const result = buildSplitPlan('tx-1', [], [], -500);

    expect(result.transactionId).toBe('tx-1');
    expect(result.splits).toHaveLength(0);
  });

  it('should negate amounts for expenses (positive cents → negative splits)', () => {
    const result = buildSplitPlan(
      'tx-1',
      [
        { amountWithTax: 1050, suggestedCategoryId: 'cat-a', description: 'Item', status: 'approved' },
      ],
      [],
      -1050,
    );

    expect(result.splits[0].amount).toBe(-1050);
  });
});
