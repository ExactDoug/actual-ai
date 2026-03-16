import { cleanDescription, buildSearchQuery } from '../src/receipt/line-item-classifier';

describe('cleanDescription', () => {
  it('should replace underscores with spaces', () => {
    expect(cleanDescription('CRFTSQ_METAL_DURO_BRSHES')).toBe('CRFTSQ METAL DURO BRSHES');
  });

  it('should remove long numeric codes (SKU/UPC)', () => {
    expect(cleanDescription('MILK 2% GAL 0001234567890')).toBe('MILK 2% GAL');
  });

  it('should not remove short numbers', () => {
    expect(cleanDescription('EGGS 12CT')).toBe('EGGS 12CT');
  });

  it('should collapse multiple spaces', () => {
    expect(cleanDescription('ITEM    WITH   SPACES')).toBe('ITEM WITH SPACES');
  });

  it('should handle combined artifacts', () => {
    expect(cleanDescription('AGC_DINO_MEMOVALEN 0049000012345')).toBe('AGC DINO MEMOVALEN');
  });

  it('should trim whitespace', () => {
    expect(cleanDescription('  ITEM  ')).toBe('ITEM');
  });

  it('should handle empty string', () => {
    expect(cleanDescription('')).toBe('');
  });
});

describe('buildSearchQuery', () => {
  it('should combine cleaned description with vendor name', () => {
    const query = buildSearchQuery('AGC DINO MEMOVALEN', 'Albertsons');
    expect(query).toBe('"AGC DINO MEMOVALEN" Albertsons product');
  });

  it('should clean OCR artifacts before building query', () => {
    const query = buildSearchQuery('CRFTSQ_METAL_DURO_BRSHES 0049000012345', 'Dollar Tree');
    expect(query).toBe('"CRFTSQ METAL DURO BRSHES" Dollar Tree product');
  });

  it('should handle empty description', () => {
    const query = buildSearchQuery('', 'Store');
    expect(query).toBe('"" Store product');
  });
});
