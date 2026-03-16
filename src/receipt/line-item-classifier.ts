import fs from 'fs';
import { z } from 'zod';
import handlebars from '../handlebars-helpers';
import LlmService from '../llm-service';
import PromptGenerator from '../prompt-generator';
import { RuleDescription, ToolServiceI } from '../types';
import ReceiptStore from './receipt-store';
import allocateTax, { validateReceiptBalance } from './tax-allocator';
import { reconcileMatchTax } from './tax-reconciler';
import { ReceiptDocument } from './types';

const lineItemClassificationSchema = z.object({
  items: z.array(z.object({
    itemIndex: z.number(),
    type: z.string(),
    categoryId: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
  })),
});

type LlmClassificationItem = z.infer<typeof lineItemClassificationSchema>['items'][number];

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

interface StoredClassification {
  id: string;
  lineItemIndex: number;
  description: string;
  confidence: string;
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
  classificationType: string | null;
  notes: string | null;
}

function formatCents(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const formatted = `$${dollars.toFixed(2)}`;
  return cents < 0 ? `-${formatted}` : formatted;
}

/**
 * Clean OCR artifacts from item descriptions for better search queries.
 */
function cleanDescription(description: string): string {
  return description
    .replace(/_/g, ' ')                    // underscores → spaces
    .replace(/\b\d{6,}\b/g, '')            // remove long numeric codes (SKU/UPC)
    .replace(/\s{2,}/g, ' ')               // collapse whitespace
    .trim();
}

/**
 * Build a web search query for a low-confidence item.
 */
function buildSearchQuery(description: string, vendorName: string): string {
  const cleaned = cleanDescription(description);
  return `"${cleaned}" ${vendorName} product`;
}

class LineItemClassifier {
  private readonly llmService: LlmService;

  private readonly promptGenerator: PromptGenerator;

  private readonly store: ReceiptStore;

  private readonly receiptTag: string;

  private readonly toolService?: ToolServiceI;

  private readonly fallbackWebSearchEnabled: boolean;

  private readonly lineItemTemplate: HandlebarsTemplateDelegate;

  private readonly fallbackTemplate: HandlebarsTemplateDelegate;

  constructor(
    llmService: LlmService,
    promptGenerator: PromptGenerator,
    store: ReceiptStore,
    receiptTag: string,
    toolService?: ToolServiceI,
    fallbackWebSearchEnabled = true,
  ) {
    this.llmService = llmService;
    this.promptGenerator = promptGenerator;
    this.store = store;
    this.receiptTag = receiptTag;
    this.toolService = toolService;
    this.fallbackWebSearchEnabled = fallbackWebSearchEnabled;

    const templateSource = fs.readFileSync('./src/templates/line-item-prompt.hbs', 'utf8').trim();
    this.lineItemTemplate = handlebars.compile(templateSource);

    const fallbackSource = fs.readFileSync('./src/templates/line-item-fallback-prompt.hbs', 'utf8').trim();
    this.fallbackTemplate = handlebars.compile(fallbackSource);
  }

  async classifyReceipt(
    matchId: string,
    categories: CategoryInfo[],
    categoryGroups: CategoryGroupInfo[],
    rules?: RuleDescription[],
  ): Promise<void> {
    // Step 1: Get match and check status
    const match = this.store.getMatch(matchId);
    if (!match) {
      console.log(`Match ${matchId} not found`);
      return;
    }
    if (match.status === 'applied') {
      console.log(`Match ${matchId} is applied — must rollback before reclassifying`);
      return;
    }
    if (match.status !== 'pending' && match.status !== 'classified' && match.status !== 'rejected') {
      return;
    }

    // Handle re-classification: delete old classifications first
    if (match.status === 'classified' || match.status === 'rejected') {
      const oldCount = this.store.deleteClassificationsForMatch(matchId);
      console.log(`Re-classifying match ${matchId} (deleted ${oldCount} previous classifications)`);
    }

    // Step 2: Get receipt data
    const receiptRow = this.store.getReceipt(match.receiptId as string);
    if (!receiptRow) {
      console.log(`Receipt not found for match ${matchId}`);
      return;
    }

    let receipt: ReceiptDocument;
    try {
      receipt = JSON.parse(receiptRow.receiptData as string) as ReceiptDocument;
    } catch (err) {
      console.error(`Failed to parse receipt data for match ${matchId}:`, err);
      return;
    }

    // Step 3: Check for line items
    if (receipt.lineItems.length === 0) {
      console.log('Skipping line-item classification (0 line items)');
      return;
    }

    // Step 4: Build prompt context
    const lineItems = receipt.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: formatCents(item.unitPrice),
      hasUnitPrice: item.unitPrice !== 0,
      totalPrice: formatCents(item.totalPrice),
    }));

    const additionalCharges: Array<{ type: string; description: string; amount: string }> = [];
    if (receipt.tipAmount !== 0) {
      additionalCharges.push({
        type: 'Tip',
        description: 'Tip',
        amount: formatCents(receipt.tipAmount),
      });
    }
    if (receipt.shippingAmount !== 0) {
      additionalCharges.push({
        type: 'Shipping',
        description: 'Shipping',
        amount: formatCents(receipt.shippingAmount),
      });
    }

    const promptContext = {
      vendorName: receipt.vendorName,
      date: receipt.date,
      accountName: '',
      lineItems,
      receiptTax: receipt.taxAmount !== 0 ? formatCents(receipt.taxAmount) : undefined,
      additionalCharges: additionalCharges.length > 0 ? additionalCharges : undefined,
      categoryGroups,
    };

    // Step 5-6: Compile template and generate prompt
    const prompt = this.lineItemTemplate(promptContext);

    // Step 7-8: Call LLM with structured output (JSON schema enforcement)
    let llmResults: LlmClassificationItem[];
    try {
      const result = await this.llmService.generateStructuredOutput(
        prompt,
        lineItemClassificationSchema,
      );
      llmResults = result.items;
    } catch (err) {
      console.error(`LLM classification failed for match ${matchId}:`, err);
      return;
    }

    // Step 9: Resolve LLM results into category assignments
    const llmResultMap = new Map<number, LlmClassificationItem>();
    for (const result of llmResults) {
      llmResultMap.set(result.itemIndex, result);
    }

    const categoryNameMap = new Map<string, string>();
    for (const cat of categories) {
      categoryNameMap.set(cat.id, cat.name);
    }

    const resolved: Array<{
      suggestedCategoryId?: string;
      suggestedCategoryName?: string;
      classificationType?: string;
      confidence?: string;
    }> = [];
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;

    for (let i = 0; i < receipt.lineItems.length; i++) {
      const llmResult = llmResultMap.get(i);
      let suggestedCategoryId: string | undefined;
      let suggestedCategoryName: string | undefined;
      let classificationType: string | undefined;
      let confidence: string | undefined;

      if (llmResult && llmResult.confidence !== 'low') {
        suggestedCategoryId = llmResult.categoryId;
        suggestedCategoryName = categoryNameMap.get(llmResult.categoryId);
        classificationType = llmResult.type;
        confidence = llmResult.confidence;
      } else {
        classificationType = 'fallback';
        confidence = llmResult?.confidence ?? 'low';
        suggestedCategoryId = llmResult?.categoryId;
        suggestedCategoryName = suggestedCategoryId
          ? categoryNameMap.get(suggestedCategoryId)
          : undefined;
      }

      if (confidence === 'high') highCount++;
      else if (confidence === 'medium') mediumCount++;
      else lowCount++;

      resolved.push({
        suggestedCategoryId, suggestedCategoryName, classificationType, confidence,
      });
    }

    // Step 10: Infer taxability from LLM category assignments (NM rules)
    const inferredTaxable = resolved.map((r) => {
      if (!r.suggestedCategoryName) return null;
      return !this.store.isCategoryTaxExempt(r.suggestedCategoryName);
    });

    // If all items are tax-exempt but receipt has tax, something is
    // misclassified — fall back to proportional allocation.
    const hasAnyTaxable = inferredTaxable.some((t) => t === true);
    const taxableFlags = (receipt.taxAmount !== 0 && !hasAnyTaxable)
      ? receipt.lineItems.map(() => null)
      : inferredTaxable;

    // Step 11: Run tax allocation using category-inferred taxability
    const taxInput = {
      lineItems: receipt.lineItems.map((item, i) => ({
        totalPrice: item.totalPrice,
        taxable: taxableFlags[i],
      })),
      totalTax: receipt.taxAmount,
    };
    const taxResult = allocateTax(taxInput);

    // Step 12: Validate receipt balance
    const lineItemAmounts = taxResult.allocations.map((a) => a.amountWithTax);
    const additionalChargesTotal = (receipt.tipAmount ?? 0) + (receipt.shippingAmount ?? 0);
    const balance = validateReceiptBalance(
      lineItemAmounts,
      additionalChargesTotal,
      receipt.totalAmount,
    );

    if (!balance.balanced) {
      console.log(
        `Receipt balance discrepancy of ${balance.discrepancy} cents for match ${matchId}, adjusting largest item`,
      );
      let largestIdx = 0;
      let largestAbs = 0;
      for (let i = 0; i < lineItemAmounts.length; i++) {
        const abs = Math.abs(lineItemAmounts[i]);
        if (abs > largestAbs) {
          largestAbs = abs;
          largestIdx = i;
        }
      }
      taxResult.allocations[largestIdx].amountWithTax += balance.discrepancy;
      taxResult.allocations[largestIdx].allocatedTax += balance.discrepancy;
    }

    // Step 13: Insert line item classifications
    for (let i = 0; i < receipt.lineItems.length; i++) {
      const item = receipt.lineItems[i];
      const allocation = taxResult.allocations[i];
      const r = resolved[i];

      this.store.insertLineItemClassification({
        receiptMatchId: matchId,
        lineItemIndex: i,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        taxable: taxableFlags[i],
        allocatedTax: allocation.allocatedTax,
        amountWithTax: allocation.amountWithTax,
        suggestedCategoryId: r.suggestedCategoryId,
        suggestedCategoryName: r.suggestedCategoryName,
        classificationType: r.classificationType,
        confidence: r.confidence,
      });
    }

    const n = receipt.lineItems.length;
    console.log(
      `Classified ${n} line items for match ${matchId} (${highCount} high, ${mediumCount} medium, ${lowCount} low confidence)`,
    );

    // Step 14: Run fallback pipeline on low-confidence items
    if (lowCount > 0) {
      await this.runFallbackPipeline(
        matchId,
        receipt,
        categories,
        categoryGroups,
        categoryNameMap,
        rules,
      );

      // Step 15: Reconcile tax after fallback may have changed categories
      this.reconcileTax(matchId, receipt);
    }

    // Step 16: Update match status
    this.store.updateMatchStatus(matchId, 'classified');
  }

  // ---------------------------------------------------------------------------
  // Tax Reconciliation (after fallback may change categories)
  // ---------------------------------------------------------------------------

  private reconcileTax(matchId: string, _receipt: ReceiptDocument): void {
    reconcileMatchTax(this.store, matchId);
    console.log(`Tax reconciled for match ${matchId} after fallback`);
  }

  // ---------------------------------------------------------------------------
  // Fallback Pipeline
  // ---------------------------------------------------------------------------

  private async runFallbackPipeline(
    matchId: string,
    receipt: ReceiptDocument,
    categories: CategoryInfo[],
    categoryGroups: CategoryGroupInfo[],
    categoryNameMap: Map<string, string>,
    rules?: RuleDescription[],
  ): Promise<void> {
    const classifications = this.store.getClassificationsForMatch(matchId) as unknown as StoredClassification[];
    const lowItems = classifications.filter((c) => c.confidence === 'low');

    if (lowItems.length === 0) return;

    // Special case: 1-2 item receipts where ALL items are low confidence
    if (receipt.lineItems.length <= 2 && lowItems.length === receipt.lineItems.length) {
      await this.handleSmallReceiptFallback(
        matchId,
        receipt,
        classifications,
        categoryGroups,
        categoryNameMap,
      );
      return;
    }

    // Run multi-tier fallback on each low-confidence item
    for (const item of lowItems) {
      let upgraded = false;

      // Tier 1: Web search + individual LLM
      if (this.fallbackWebSearchEnabled && this.toolService?.search) {
        upgraded = await this.runTier1(
          item,
          receipt,
          classifications,
          categoryGroups,
          categoryNameMap,
        );
      }

      // Tier 2: Rules-based classification
      if (!upgraded && rules && rules.length > 0) {
        upgraded = this.runTier2(item, rules, categoryNameMap);
      }

      // Tier 3: Majority category assignment
      if (!upgraded) {
        upgraded = this.runTier3(item, matchId, categoryNameMap);
      }

      // Tier 4: Left for manual review
      if (!upgraded) {
        this.store.updateLineItemClassification(item.id, {
          notes: 'fallback:tier4:manual-review',
        });
        console.log(`[fallback] Item ${item.lineItemIndex}: remains low confidence, left for manual review`);
      }
    }
  }

  /**
   * Tier 1: Web search + individual LLM classification.
   * Searches for the item description + vendor name, then asks the LLM
   * to classify the single item with search results as context.
   */
  private async runTier1(
    item: StoredClassification,
    receipt: ReceiptDocument,
    allClassifications: StoredClassification[],
    categoryGroups: CategoryGroupInfo[],
    categoryNameMap: Map<string, string>,
  ): Promise<boolean> {
    try {
      const query = buildSearchQuery(item.description, receipt.vendorName);
      const searchResults = await this.toolService!.search!(query);

      // Build context: other items that were classified with high/medium confidence
      const otherItems = allClassifications
        .filter((c) => c.lineItemIndex !== item.lineItemIndex
          && (c.confidence === 'high' || c.confidence === 'medium')
          && c.suggestedCategoryName)
        .map((c) => ({
          description: c.description,
          categoryName: c.suggestedCategoryName!,
          confidence: c.confidence,
        }));

      const lineItem = receipt.lineItems[item.lineItemIndex];
      const prompt = this.fallbackTemplate({
        vendorName: receipt.vendorName,
        date: receipt.date,
        itemDescription: item.description,
        itemQuantity: lineItem?.quantity ?? 1,
        itemTotalPrice: formatCents(lineItem?.totalPrice ?? 0),
        itemIndex: item.lineItemIndex,
        searchResults: searchResults !== 'Search unavailable'
          && searchResults !== 'Search tool is not available.'
          ? searchResults : undefined,
        otherItems: otherItems.length > 0 ? otherItems : undefined,
        categoryGroups,
      });

      const result = await this.llmService.generateStructuredOutput(
        prompt,
        lineItemClassificationSchema,
      );

      const llmItem = result.items.find((r) => r.itemIndex === item.lineItemIndex);
      if (llmItem && (llmItem.confidence === 'high' || llmItem.confidence === 'medium')) {
        this.store.updateLineItemClassification(item.id, {
          suggestedCategoryId: llmItem.categoryId,
          suggestedCategoryName: categoryNameMap.get(llmItem.categoryId),
          classificationType: llmItem.type,
          confidence: llmItem.confidence,
          notes: 'fallback:tier1:web-search',
        });
        console.log(
          `[fallback] Item ${item.lineItemIndex}: upgraded low→${llmItem.confidence} via web search`,
        );
        return true;
      }
    } catch (err) {
      console.error(`[fallback] Tier 1 failed for item ${item.lineItemIndex}:`, err);
    }
    return false;
  }

  /**
   * Tier 2: Rules-based classification.
   * Checks item description against Actual Budget transaction rules.
   */
  private runTier2(
    item: StoredClassification,
    rules: RuleDescription[],
    categoryNameMap: Map<string, string>,
  ): boolean {
    const descLower = item.description.toLowerCase();
    const cleanedLower = cleanDescription(item.description).toLowerCase();

    for (const rule of rules) {
      if (!rule.categoryId) continue;

      const matched = rule.conditions.some((cond) => {
        // Only match on payee-like fields
        if (cond.field !== 'payee' && cond.field !== 'imported_payee' && cond.field !== 'notes') {
          return false;
        }

        const values = Array.isArray(cond.value) ? cond.value : [cond.value];

        return values.some((val) => {
          const valLower = val.toLowerCase();
          if (cond.op === 'contains' || cond.op === 'matches') {
            return descLower.includes(valLower) || cleanedLower.includes(valLower);
          }
          if (cond.op === 'is' || cond.op === 'isNot') {
            // For 'is', check substring both ways (item descriptions are often abbreviated)
            return cond.op === 'is'
              && (descLower.includes(valLower) || valLower.includes(descLower)
                || cleanedLower.includes(valLower) || valLower.includes(cleanedLower));
          }
          if (cond.op === 'oneOf') {
            return descLower.includes(valLower) || cleanedLower.includes(valLower);
          }
          return false;
        });
      });

      if (matched) {
        this.store.updateLineItemClassification(item.id, {
          suggestedCategoryId: rule.categoryId,
          suggestedCategoryName: categoryNameMap.get(rule.categoryId) ?? rule.categoryName,
          classificationType: 'rule',
          confidence: 'medium',
          notes: `fallback:tier2:rule-match:${rule.ruleName}`,
        });
        console.log(
          `[fallback] Item ${item.lineItemIndex}: upgraded low→medium via rule "${rule.ruleName}"`,
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Tier 3: Majority category assignment.
   * Uses the most common category from other classified items on the same receipt.
   */
  private runTier3(
    item: StoredClassification,
    matchId: string,
    categoryNameMap: Map<string, string>,
  ): boolean {
    const allClassifications = this.store.getClassificationsForMatch(matchId) as unknown as StoredClassification[];

    // Count categories from high/medium confidence items
    const categoryCounts = new Map<string, number>();
    for (const c of allClassifications) {
      if (c.lineItemIndex === item.lineItemIndex) continue;
      if ((c.confidence === 'high' || c.confidence === 'medium') && c.suggestedCategoryId) {
        categoryCounts.set(
          c.suggestedCategoryId,
          (categoryCounts.get(c.suggestedCategoryId) ?? 0) + 1,
        );
      }
    }

    if (categoryCounts.size === 0) return false;

    // Find the most common category
    let bestCategoryId = '';
    let bestCount = 0;
    for (const [catId, count] of categoryCounts) {
      if (count > bestCount) {
        bestCount = count;
        bestCategoryId = catId;
      }
    }

    if (!bestCategoryId) return false;

    this.store.updateLineItemClassification(item.id, {
      suggestedCategoryId: bestCategoryId,
      suggestedCategoryName: categoryNameMap.get(bestCategoryId),
      classificationType: 'fallback',
      confidence: 'low',
      notes: 'fallback:tier3:majority-category',
    });
    console.log(
      `[fallback] Item ${item.lineItemIndex}: assigned majority category "${categoryNameMap.get(bestCategoryId)}"`,
    );
    return true;
  }

  /**
   * Special case: 1-2 item receipts where ALL items are low confidence.
   * Falls back to whole-transaction classification using the vendor name
   * and receipt total as context, rather than trying individual items.
   */
  private async handleSmallReceiptFallback(
    matchId: string,
    receipt: ReceiptDocument,
    classifications: StoredClassification[],
    categoryGroups: CategoryGroupInfo[],
    categoryNameMap: Map<string, string>,
  ): Promise<void> {
    console.log(
      `[fallback] Receipt ${receipt.externalId}: all ${receipt.lineItems.length} items low confidence, using whole-transaction classification`,
    );

    try {
      // Build a simplified prompt treating the whole receipt as one transaction
      const prompt = this.lineItemTemplate({
        vendorName: receipt.vendorName,
        date: receipt.date,
        accountName: '',
        lineItems: [{
          description: `Entire purchase at ${receipt.vendorName}`,
          quantity: 1,
          unitPrice: formatCents(receipt.totalAmount),
          totalPrice: formatCents(receipt.totalAmount),
        }],
        categoryGroups,
      });

      const result = await this.llmService.generateStructuredOutput(
        prompt,
        lineItemClassificationSchema,
      );

      const llmItem = result.items[0];
      if (llmItem && llmItem.categoryId) {
        const categoryName = categoryNameMap.get(llmItem.categoryId);
        // Apply the whole-transaction category to all items
        for (const cls of classifications) {
          this.store.updateLineItemClassification(cls.id, {
            suggestedCategoryId: llmItem.categoryId,
            suggestedCategoryName: categoryName,
            classificationType: llmItem.type,
            confidence: llmItem.confidence,
            notes: 'fallback:whole-transaction',
          });
        }
        console.log(
          `[fallback] Receipt ${receipt.externalId}: classified as "${categoryName}" (${llmItem.confidence} confidence)`,
        );
      }
    } catch (err) {
      console.error(`[fallback] Whole-transaction classification failed for receipt ${receipt.externalId}:`, err);
      // Leave items with their original low-confidence classifications
      for (const cls of classifications) {
        this.store.updateLineItemClassification(cls.id, {
          notes: 'fallback:tier4:manual-review',
        });
      }
    }
  }
}

export { cleanDescription, buildSearchQuery, formatCents };
export default LineItemClassifier;
