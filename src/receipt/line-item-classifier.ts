import fs from 'fs';
import handlebars from '../handlebars-helpers';
import LlmService from '../llm-service';
import PromptGenerator from '../prompt-generator';
import ReceiptStore from './receipt-store';
import allocateTax, { validateReceiptBalance } from './tax-allocator';
import { ReceiptDocument } from './types';
import { cleanJsonResponse } from '../utils/json-utils';

interface LlmClassificationItem {
  itemIndex: number;
  type: string;
  categoryId: string;
  confidence: string;
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

function formatCents(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const formatted = `$${dollars.toFixed(2)}`;
  return cents < 0 ? `-${formatted}` : formatted;
}

class LineItemClassifier {
  private readonly llmService: LlmService;

  private readonly promptGenerator: PromptGenerator;

  private readonly store: ReceiptStore;

  private readonly receiptTag: string;

  private readonly lineItemTemplate: HandlebarsTemplateDelegate;

  constructor(
    llmService: LlmService,
    promptGenerator: PromptGenerator,
    store: ReceiptStore,
    receiptTag: string,
  ) {
    this.llmService = llmService;
    this.promptGenerator = promptGenerator;
    this.store = store;
    this.receiptTag = receiptTag;

    const templateSource = fs.readFileSync('./src/templates/line-item-prompt.hbs', 'utf8').trim();
    this.lineItemTemplate = handlebars.compile(templateSource);
  }

  async classifyReceipt(
    matchId: string,
    categories: CategoryInfo[],
    categoryGroups: CategoryGroupInfo[],
  ): Promise<void> {
    // Step 1: Get match and check status
    const match = this.store.getMatch(matchId);
    if (!match) {
      console.log(`Match ${matchId} not found`);
      return;
    }
    if (match.status !== 'pending') {
      return;
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
      additionalCharges: additionalCharges.length > 0 ? additionalCharges : undefined,
      categoryGroups,
    };

    // Step 5-6: Compile template and generate prompt
    const prompt = this.lineItemTemplate(promptContext);

    // Step 7: Call LLM
    let llmResponseText: string;
    try {
      // ask() returns UnifiedResponse for standard classification. For line-item
      // classification we need the raw text (JSON array). Use askUsingFallbackModel
      // which returns the raw LLM output as a string. We apply cleanJsonResponse
      // ourselves to extract the JSON array from any surrounding text.
      const rawText = await this.llmService.askUsingFallbackModel(prompt);
      llmResponseText = rawText;
    } catch (err) {
      console.error(`LLM call failed for match ${matchId}:`, err);
      return;
    }

    // Step 8: Parse response as JSON array
    let llmResults: LlmClassificationItem[];
    try {
      const cleaned = cleanJsonResponse(llmResponseText);
      llmResults = JSON.parse(cleaned) as LlmClassificationItem[];
      if (!Array.isArray(llmResults)) {
        throw new Error('LLM response is not a JSON array');
      }
    } catch (err) {
      console.error(`Failed to parse LLM classification response for match ${matchId}:`, err);
      return;
    }

    // Step 9: Run tax allocation
    const taxInput = {
      lineItems: receipt.lineItems.map((item) => ({
        totalPrice: item.totalPrice,
        taxable: item.taxable ?? null,
      })),
      totalTax: receipt.taxAmount,
    };
    const taxResult = allocateTax(taxInput);

    // Step 10: Validate receipt balance
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
      // Adjust the largest item to account for discrepancy
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

    // Step 11: Insert line item classifications
    // Build a lookup map from itemIndex to LLM result
    const llmResultMap = new Map<number, LlmClassificationItem>();
    for (const result of llmResults) {
      llmResultMap.set(result.itemIndex, result);
    }

    // Build a category name lookup map
    const categoryNameMap = new Map<string, string>();
    for (const cat of categories) {
      categoryNameMap.set(cat.id, cat.name);
    }

    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;

    for (let i = 0; i < receipt.lineItems.length; i++) {
      const item = receipt.lineItems[i];
      const allocation = taxResult.allocations[i];
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

      this.store.insertLineItemClassification({
        receiptMatchId: matchId,
        lineItemIndex: i,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        taxable: item.taxable ?? null,
        allocatedTax: allocation.allocatedTax,
        amountWithTax: allocation.amountWithTax,
        suggestedCategoryId,
        suggestedCategoryName,
        classificationType,
        confidence,
      });
    }

    // Step 12: Update match status
    this.store.updateMatchStatus(matchId, 'classified');

    // Step 13: Log summary
    const n = receipt.lineItems.length;
    console.log(
      `Classified ${n} line items for match ${matchId} (${highCount} high, ${mediumCount} medium, ${lowCount} low confidence)`,
    );
  }
}

export default LineItemClassifier;
