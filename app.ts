import cron from 'node-cron';
import crypto from 'crypto';
import fs from 'fs';
import {
  cronSchedule, isFeatureEnabled, password, serverURL, budgetId,
  e2ePassword, dataDir, llmProvider, openaiModel, openaiBaseURL,
  guessedTag, notGuessedTag,
} from './src/config';
import actualAi from './src/container';
import {
  transactionProcessor as txProcessor,
  classificationStore,
  receiptFetchService,
  receiptStore,
  connectorRegistry,
  matchingService,
  lineItemClassifier,
  splitTransactionService,
  batchService,
} from './src/container';
import { createWebServer } from './src/web/server';
import type { UnifiedResponse, APICategoryEntity, APICategoryGroupEntity, RuleDescription } from './src/types';
import type { TransactionEntity, RuleEntity } from '@actual-app/api/@types/loot-core/src/types/models';
import { transformRulesToDescriptions } from './src/utils/rule-utils';
import ActualBudgetConnection from './src/actual-budget-connection';

// Shared persistent connection to Actual Budget (replaces createTempApiService for web requests)
const budgetConnection = new ActualBudgetConnection({
  serverURL, password, budgetId, e2ePassword, dataDir,
});

const REVIEW_UI_PORT = parseInt(process.env.REVIEW_UI_PORT ?? '3000', 10);
const REVIEW_UI_ENABLED = process.env.REVIEW_UI_ENABLED !== 'false';

// Ensure dataDir exists for SQLite
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let currentRunId = '';

// Wire the classification callback to capture LLM results
txProcessor.setOnClassified(
  (transaction: TransactionEntity, response: UnifiedResponse, categories: (APICategoryEntity | APICategoryGroupEntity)[]) => {
    const category = response.categoryId
      ? categories.find((c) => 'id' in c && c.id === response.categoryId) as (APICategoryEntity & { group?: APICategoryGroupEntity }) | undefined
      : undefined;

    // Find account name - stored on the transaction
    const accountName = (transaction as unknown as { account_name?: string }).account_name ?? '';

    // Find payee name
    const payeeName = (transaction as unknown as { payee_name?: string }).payee_name
      ?? transaction.imported_payee
      ?? '';

    // Find category group name
    let groupName = '';
    if (category && 'group' in category) {
      const group = categories.find((c) => 'id' in c && c.id === (category as unknown as { group_id?: string }).group_id);
      if (group && 'name' in group) groupName = group.name;
    }

    classificationStore.clearPendingForTransaction(transaction.id);
    classificationStore.insert({
      transactionId: transaction.id,
      date: transaction.date ?? '',
      amount: transaction.amount ?? 0,
      payee: payeeName,
      importedPayee: transaction.imported_payee ?? '',
      notes: transaction.notes ?? '',
      accountName,
      suggestedCategoryId: response.categoryId ?? '',
      suggestedCategoryName: category && 'name' in category ? (category.name ?? '') : (response.newCategory?.name ?? ''),
      suggestedCategoryGroup: groupName || (response.newCategory?.groupName ?? ''),
      classificationType: response.type,
      matchedRuleName: response.ruleName ?? null,
      newCategoryName: response.newCategory?.name ?? null,
      newGroupName: response.newCategory?.groupName ?? null,
      newGroupIsNew: response.newCategory?.groupIsNew ? 1 : null,
      classifiedAt: new Date().toISOString(),
      runId: currentRunId,
    });
  },
);

// Helper to read automation settings from SQLite
function autoSetting(key: string, defaultValue = true): boolean {
  return receiptStore.getSettingBool(key, defaultValue);
}

// Classification runner — each step gated by persistent settings
async function runClassification() {
  if (!autoSetting('cron.enabled')) {
    console.log('[cron] Skipping — cron.enabled is false');
    return;
  }

  currentRunId = crypto.randomUUID();

  // Step 1: Fetch receipts from Veryfi
  if (isFeatureEnabled('receiptMatching') && autoSetting('cron.autoFetchReceipts')) {
    try {
      const fetchResult = await receiptFetchService.fetchAll();
      if (fetchResult.errors.length > 0) {
        console.warn(`Receipt fetch completed with ${fetchResult.errors.length} error(s)`);
      }
    } catch (err) {
      console.error('Receipt fetch failed (continuing with classification):', err);
    }
  }

  // Step 2: Match receipts to transactions
  if (isFeatureEnabled('receiptMatching') && autoSetting('cron.autoMatchReceipts')) {
    try {
      const { transactions, payeeMap } = await budgetConnection.getAllTransactionsForMatching();
      const matchable = transactions.filter((t) => !t.is_parent && t.amount !== 0);
      matchingService.matchAll(matchable.map((t) => ({
        id: t.id,
        amount: t.amount,
        date: t.date,
        payee: t.payee ? payeeMap.get(t.payee) : undefined,
        imported_payee: t.imported_payee ?? undefined,
        hasCategory: !!t.category,
        categoryId: t.category ?? undefined,
      })));
    } catch (err) {
      console.error('Receipt matching failed (continuing with classification):', err);
    }
  }

  // Step 3: LLM transaction classification
  if (autoSetting('cron.autoClassifyTransactions')) {
    await actualAi.classify();
  }
}

// Start cron
if (!isFeatureEnabled('classifyOnStartup') && !cron.validate(cronSchedule)) {
  console.error('classifyOnStartup not set or invalid cron schedule:', cronSchedule);
  if (!REVIEW_UI_ENABLED) {
    process.exit(1);
  }
}

if (cron.validate(cronSchedule)) {
  cron.schedule(cronSchedule, async () => {
    await runClassification();
  });
}

console.log('Application started');

if (isFeatureEnabled('classifyOnStartup')) {
  (async () => {
    await runClassification();
  })();
} else {
  console.log('Waiting for cron schedule:', cronSchedule);
}

// Start web server
if (REVIEW_UI_ENABLED) {
  const webApp = createWebServer({
    actualPassword: password,
    classificationStore,

    async onApply(classifications) {
      // Apply approved classifications to Actual Budget
      let applied = 0;
      let skipped = 0;
      const appliedIds: string[] = [];

      for (const c of classifications) {
        try {
          const taggedNotes = `${c.notes ? c.notes + ' ' : ''}${guessedTag}`;
          await budgetConnection.updateTransaction(c.transactionId, {
            notes: taggedNotes,
            category: c.suggestedCategoryId,
          });
          appliedIds.push(c.id);
          classificationStore.clearWriteError(c.id);
          applied++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Failed to apply classification ${c.id}:`, msg);
          classificationStore.setWriteError(c.id, msg);
          skipped++;
        }
      }

      if (appliedIds.length > 0) {
        classificationStore.markApplied(appliedIds);
      }

      return { applied, skipped };
    },

    async onTriggerClassify() {
      // Fire and forget
      runClassification().catch((err) => console.error('Manual classification failed:', err));
    },

    async getCategories() {
      return budgetConnection.getCategories();
    },

    receiptStore: isFeatureEnabled('receiptMatching') ? receiptStore : undefined,
    connectorRegistry: isFeatureEnabled('receiptMatching') ? connectorRegistry : undefined,

    getVeryfiProfiles: isFeatureEnabled('receiptMatching') && connectorRegistry.get('veryfi')
      ? async () => {
        const adapter = connectorRegistry.get('veryfi') as import('./src/receipt/veryfi-adapter').default;
        const client = await adapter.getClient();
        const profiles = await client.getProfiles();
        return profiles.map((p) => ({
          username: p.username,
          companyName: p.companyName,
          accountId: p.accountId,
          isPrimary: p.isPrimary,
          type: p.type,
          displayType: p.displayType,
        }));
      }
      : undefined,

    onReceiptFetch: isFeatureEnabled('receiptMatching')
      ? () => receiptFetchService.fetchAll()
      : undefined,

    onReceiptClassify: isFeatureEnabled('lineItemClassification')
      ? async (matchId: string) => {
        const { flatCats, groupsForPrompt, ruleDescriptions, shutdown } = await fetchClassificationContext();
        try {
          await lineItemClassifier.classifyReceipt(matchId, flatCats, groupsForPrompt, ruleDescriptions);
        } finally {
          await shutdown();
        }
      }
      : undefined,

    onReceiptApplySplit: isFeatureEnabled('receiptMatching')
      ? async (matchId: string) => {
        await budgetConnection.withApi(async () => {
          await splitTransactionService.applySplit(matchId);
        });
        // Evict cached transaction data for this match
        const match = receiptStore.getMatch(matchId);
        if (match) budgetConnection.evict(match.transactionId as string);
      }
      : undefined,

    onReceiptUnmatch: isFeatureEnabled('receiptMatching')
      ? (matchId: string) => matchingService.unmatch(matchId)
      : undefined,

    onReceiptRematch: isFeatureEnabled('receiptMatching')
      ? (matchId: string, txId: string) => matchingService.rematch(matchId, txId)
      : undefined,

    onReceiptRollback: isFeatureEnabled('receiptMatching')
      ? async (matchId: string) => {
        const match = receiptStore.getMatch(matchId);
        await budgetConnection.withApi(async () => {
          await splitTransactionService.rollbackSplit(matchId);
        });
        if (match) budgetConnection.evict(match.transactionId as string);
      }
      : undefined,

    onBatchClassify: isFeatureEnabled('lineItemClassification')
      ? async (request) => {
        const { flatCats, groupsForPrompt, ruleDescriptions, shutdown } = await fetchClassificationContext();
        try {
          return await batchService.batchClassify(request, flatCats, groupsForPrompt, ruleDescriptions);
        } finally {
          await shutdown();
        }
      }
      : undefined,

    onBatchApprove: isFeatureEnabled('receiptMatching')
      ? (request) => batchService.batchApprove(request)
      : undefined,

    onBatchApply: isFeatureEnabled('receiptMatching')
      ? (request) => batchService.batchApply(request)
      : undefined,

    onBatchUnmatch: isFeatureEnabled('receiptMatching')
      ? (request) => batchService.batchUnmatch(request)
      : undefined,

    onBatchReject: isFeatureEnabled('receiptMatching')
      ? (request) => batchService.batchReject(request)
      : undefined,

    onResetAndRematch: isFeatureEnabled('receiptMatching')
      ? async () => {
        const { reset, preserved, errors: resetErrors } = batchService.resetForRematch();

        const { transactions, payeeMap } = await budgetConnection.getAllTransactionsForMatching();
        const matchable = transactions.filter((t) => !t.is_parent && t.amount !== 0);
        const rematchSummary = matchingService.matchAll(matchable.map((t) => ({
          id: t.id,
          amount: t.amount,
          date: t.date,
          payee: t.payee ? payeeMap.get(t.payee) : undefined,
          imported_payee: t.imported_payee ?? undefined,
          hasCategory: !!t.category,
          categoryId: t.category ?? undefined,
        })));

        budgetConnection.invalidateAll();
        return { reset, preserved, resetErrors, rematchSummary };
      }
      : undefined,

    onBatchReclassify: isFeatureEnabled('lineItemClassification')
      ? async (request) => {
        const { flatCats, groupsForPrompt, ruleDescriptions, shutdown } = await fetchClassificationContext();
        try {
          return await batchService.batchReclassify(request, flatCats, groupsForPrompt, ruleDescriptions);
        } finally {
          await shutdown();
        }
      }
      : undefined,

    async getTransactionDetails(transactionId: string) {
      return budgetConnection.getTransactionDetails(transactionId);
    },

    async getTransactionsBulk(transactionIds: string[]) {
      return budgetConnection.getTransactionsBulk(transactionIds);
    },

    getConfig() {
      return {
        llmProvider,
        openaiModel,
        openaiBaseURL,
        serverURL,
        budgetId,
        cronSchedule,
        dryRun: isFeatureEnabled('dryRun'),
        features: {
          classifyOnStartup: isFeatureEnabled('classifyOnStartup'),
          syncAccountsBeforeClassify: isFeatureEnabled('syncAccountsBeforeClassify'),
          suggestNewCategories: isFeatureEnabled('suggestNewCategories'),
          freeWebSearch: isFeatureEnabled('freeWebSearch'),
          dryRun: isFeatureEnabled('dryRun'),
        },
      };
    },
  });

  webApp.listen(REVIEW_UI_PORT, () => {
    console.log(`Review UI available at http://localhost:${REVIEW_UI_PORT}`);
  });
}

// Helper to fetch categories, groups, and rules for classification operations
async function fetchClassificationContext() {
  const groups = await budgetConnection.getCategoryGroups() as { id?: string; name?: string; categories?: { id: string; name: string }[] }[];
  const payeeMap = await budgetConnection.getPayees();
  const payees = [...payeeMap.entries()].map(([id, name]) => ({ id, name }));
  const rules = await budgetConnection.getRules() as RuleEntity[];
  const flatCats: { id: string; name: string; group?: string }[] = [];
  const groupsForPrompt: { id: string; name: string; categories: { id: string; name: string }[] }[] = [];
  for (const group of groups) {
    const cats: { id: string; name: string }[] = [];
    if (group.categories && Array.isArray(group.categories)) {
      for (const cat of group.categories) {
        flatCats.push({ id: cat.id, name: cat.name, group: group.name ?? '' });
        cats.push({ id: cat.id, name: cat.name });
      }
    }
    groupsForPrompt.push({ id: group.id ?? '', name: group.name ?? '', categories: cats });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ruleDescriptions = transformRulesToDescriptions(rules as any, groups as any, payees as any);
  return { flatCats, groupsForPrompt, ruleDescriptions, shutdown: () => Promise.resolve() };
}

// Helper to create a temporary API connection for applying classifications
// createTempApiService removed — all web requests now use budgetConnection
