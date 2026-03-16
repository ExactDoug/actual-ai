import cron from 'node-cron';
import crypto from 'crypto';
import fs from 'fs';
import * as actualApiClient from '@actual-app/api';
import {
  cronSchedule, isFeatureEnabled, password, serverURL, budgetId,
  e2ePassword, dataDir, llmProvider, openaiModel, openaiBaseURL,
  guessedTag, notGuessedTag,
} from './src/config';
import actualAi from './src/container';
import {
  transactionProcessor as txProcessor,
  receiptFetchService,
  receiptStore,
  connectorRegistry,
  matchingService,
  lineItemClassifier,
  splitTransactionService,
  batchService,
} from './src/container';
import ClassificationStore from './src/web/classification-store';
import { createWebServer } from './src/web/server';
import type { UnifiedResponse, APICategoryEntity, APICategoryGroupEntity, RuleDescription } from './src/types';
import type { TransactionEntity } from '@actual-app/api/@types/loot-core/src/types/models';
import { transformRulesToDescriptions } from './src/utils/rule-utils';

const REVIEW_UI_PORT = parseInt(process.env.REVIEW_UI_PORT ?? '3000', 10);
const REVIEW_UI_ENABLED = process.env.REVIEW_UI_ENABLED !== 'false';

// Ensure dataDir exists for SQLite
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const classificationStore = new ClassificationStore(dataDir);
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

// Classification runner
async function runClassification() {
  currentRunId = crypto.randomUUID();

  // Fetch receipts and run matching before classification
  if (isFeatureEnabled('receiptMatching')) {
    try {
      const fetchResult = await receiptFetchService.fetchAll();
      if (fetchResult.errors.length > 0) {
        console.warn(`Receipt fetch completed with ${fetchResult.errors.length} error(s)`);
      }
    } catch (err) {
      console.error('Receipt fetch failed (continuing with classification):', err);
    }

    try {
      // Get uncategorized transactions for matching
      const tempApi = await createTempApiService();
      try {
        const accounts = await tempApi.getAccounts();
        let transactions: TransactionEntity[] = [];
        for (const account of accounts) {
          transactions = transactions.concat(
            await tempApi.getTransactions(account.id, '1990-01-01', '2030-01-01'),
          );
        }
        // Build payee ID → name lookup
        const payees = await tempApi.getPayees();
        const payeeMap = new Map<string, string>();
        for (const p of payees) {
          if (p.id && p.name) payeeMap.set(p.id, p.name);
        }
        // Match receipts against all non-split transactions (including already-categorized ones).
        // Matches to already-categorized transactions are flagged as overridesExisting
        // and require explicit user approval before applying.
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
      } finally {
        await tempApi.shutdown();
      }
    } catch (err) {
      console.error('Receipt matching failed (continuing with classification):', err);
    }
  }

  await actualAi.classify();
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
      const apiService = await createTempApiService();
      let applied = 0;
      let skipped = 0;
      const appliedIds: string[] = [];

      try {
        for (const c of classifications) {
          try {
            const taggedNotes = `${c.notes ? c.notes + ' ' : ''}${guessedTag}`;
            await apiService.updateTransaction(c.transactionId, {
              notes: taggedNotes,
              category: c.suggestedCategoryId,
            });
            appliedIds.push(c.id);
            applied++;
          } catch (err) {
            console.error(`Failed to apply classification ${c.id}:`, err);
            skipped++;
          }
        }

        if (appliedIds.length > 0) {
          classificationStore.markApplied(appliedIds);
        }
      } finally {
        await apiService.shutdown();
      }

      return { applied, skipped };
    },

    async onTriggerClassify() {
      // Fire and forget
      runClassification().catch((err) => console.error('Manual classification failed:', err));
    },

    async getCategories() {
      const apiService = await createTempApiService();
      try {
        const groups = await apiService.getCategoryGroups();
        const result: { id: string; name: string; group: string }[] = [];
        for (const group of groups) {
          if ('categories' in group && Array.isArray(group.categories)) {
            for (const cat of group.categories as { id: string; name: string }[]) {
              result.push({ id: cat.id, name: cat.name, group: group.name ?? '' });
            }
          }
        }
        await apiService.shutdown();
        return result;
      } catch (err) {
        await apiService.shutdown();
        throw err;
      }
    },

    receiptStore: isFeatureEnabled('receiptMatching') ? receiptStore : undefined,
    connectorRegistry: isFeatureEnabled('receiptMatching') ? connectorRegistry : undefined,

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
        const apiService = await createTempApiService();
        try {
          await splitTransactionService.applySplit(matchId);
        } finally {
          await apiService.shutdown();
        }
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
        const apiService = await createTempApiService();
        try {
          await splitTransactionService.rollbackSplit(matchId);
        } finally {
          await apiService.shutdown();
        }
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
      const apiService = await createTempApiService();
      try {
        const accounts = await apiService.getAccounts();
        const accountMap = new Map<string, string>();
        let allTransactions: TransactionEntity[] = [];
        for (const account of accounts) {
          if (account.id && account.name) accountMap.set(account.id, account.name);
          allTransactions = allTransactions.concat(
            await apiService.getTransactions(account.id, '1990-01-01', '2030-01-01'),
          );
        }
        const tx = allTransactions.find((t) => t.id === transactionId);
        if (!tx) return null;

        // Build payee and category lookups
        const payees = await apiService.getPayees();
        const payeeMap = new Map<string, string>();
        for (const p of payees) {
          if (p.id && p.name) payeeMap.set(p.id, p.name);
        }
        const groups = await apiService.getCategoryGroups();
        const catMap = new Map<string, string>();
        for (const group of groups) {
          if ('categories' in group && Array.isArray(group.categories)) {
            for (const cat of group.categories as { id: string; name: string }[]) {
              catMap.set(cat.id, cat.name);
            }
          }
        }

        const dateStr = String(tx.date ?? '');
        const formattedDate = /^\d{8}$/.test(dateStr)
          ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
          : dateStr;

        const result: {
          date?: string;
          payeeName?: string;
          importedPayee?: string;
          accountName?: string;
          categoryId?: string;
          categoryName?: string;
          isParent?: boolean;
          subtransactions?: { amount: number; categoryId?: string; categoryName?: string }[];
        } = {
          date: formattedDate,
          payeeName: tx.payee ? payeeMap.get(tx.payee) ?? '' : '',
          importedPayee: tx.imported_payee ?? '',
          accountName: (tx as unknown as { account?: string }).account
            ? accountMap.get((tx as unknown as { account: string }).account) ?? ''
            : '',
        };

        if (tx.is_parent) {
          result.isParent = true;
          const subs = allTransactions.filter((t) => t.parent_id === tx.id);
          result.subtransactions = subs.map((s) => ({
            amount: s.amount,
            categoryId: s.category ?? undefined,
            categoryName: s.category ? catMap.get(s.category) : undefined,
          }));
        } else if (tx.category) {
          result.categoryId = tx.category;
          result.categoryName = catMap.get(tx.category);
        }

        return result;
      } finally {
        await apiService.shutdown();
      }
    },

    async getTransactionsBulk(transactionIds: string[]) {
      const apiService = await createTempApiService();
      try {
        const accounts = await apiService.getAccounts();
        const accountMap = new Map<string, string>();
        let allTransactions: TransactionEntity[] = [];
        for (const account of accounts) {
          if (account.id && account.name) accountMap.set(account.id, account.name);
          allTransactions = allTransactions.concat(
            await apiService.getTransactions(account.id, '1990-01-01', '2030-01-01'),
          );
        }

        const payees = await apiService.getPayees();
        const payeeMap = new Map<string, string>();
        for (const p of payees) {
          if (p.id && p.name) payeeMap.set(p.id, p.name);
        }
        const groups = await apiService.getCategoryGroups();
        const catMap = new Map<string, string>();
        for (const group of groups) {
          if ('categories' in group && Array.isArray(group.categories)) {
            for (const cat of group.categories as { id: string; name: string }[]) {
              catMap.set(cat.id, cat.name);
            }
          }
        }

        // Build account lookup from transactions (account field is the account ID)
        const txAccountMap = new Map<string, string>();
        for (const tx of allTransactions) {
          const acctId = (tx as unknown as { account?: string }).account;
          if (acctId) txAccountMap.set(tx.id, acctId);
        }

        const requestedSet = new Set(transactionIds);
        const result: Record<string, {
          date?: string;
          payeeName?: string;
          importedPayee?: string;
          accountName?: string;
          categoryId?: string;
          categoryName?: string;
          isParent?: boolean;
          subtransactions?: { amount: number; categoryId?: string; categoryName?: string }[];
        }> = {};

        for (const tx of allTransactions) {
          if (!requestedSet.has(tx.id)) continue;

          const dateStr = String(tx.date ?? '');
          const formattedDate = /^\d{8}$/.test(dateStr)
            ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
            : dateStr;

          const acctId = txAccountMap.get(tx.id);
          const entry: typeof result[string] = {
            date: formattedDate,
            payeeName: tx.payee ? payeeMap.get(tx.payee) ?? '' : '',
            importedPayee: tx.imported_payee ?? '',
            accountName: acctId ? accountMap.get(acctId) ?? '' : '',
          };

          if (tx.is_parent) {
            entry.isParent = true;
            const subs = allTransactions.filter((t) => t.parent_id === tx.id);
            entry.subtransactions = subs.map((s) => ({
              amount: s.amount,
              categoryId: s.category ?? undefined,
              categoryName: s.category ? catMap.get(s.category) : undefined,
            }));
          } else if (tx.category) {
            entry.categoryId = tx.category;
            entry.categoryName = catMap.get(tx.category);
          }

          result[tx.id] = entry;
        }

        return result;
      } finally {
        await apiService.shutdown();
      }
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
  const apiService = await createTempApiService();
  const groups = await apiService.getCategoryGroups();
  const payees = await apiService.getPayees();
  const rules = await apiService.getRules();
  const flatCats: { id: string; name: string; group?: string }[] = [];
  const groupsForPrompt: { id: string; name: string; categories: { id: string; name: string }[] }[] = [];
  for (const group of groups) {
    const cats: { id: string; name: string }[] = [];
    if ('categories' in group && Array.isArray(group.categories)) {
      for (const cat of group.categories as { id: string; name: string }[]) {
        flatCats.push({ id: cat.id, name: cat.name, group: group.name ?? '' });
        cats.push({ id: cat.id, name: cat.name });
      }
    }
    groupsForPrompt.push({ id: group.id ?? '', name: group.name ?? '', categories: cats });
  }
  const ruleDescriptions = transformRulesToDescriptions(rules, groups, payees);
  return { flatCats, groupsForPrompt, ruleDescriptions, shutdown: () => apiService.shutdown() };
}

// Helper to create a temporary API connection for applying classifications
async function createTempApiService(): Promise<typeof actualApiClient> {
  const applyDir = dataDir + 'apply/';
  if (!fs.existsSync(applyDir)) {
    fs.mkdirSync(applyDir, { recursive: true });
  }
  await actualApiClient.init({
    dataDir: applyDir,
    serverURL,
    password,
  });

  if (e2ePassword) {
    await actualApiClient.downloadBudget(budgetId, { password: e2ePassword });
  } else {
    await actualApiClient.downloadBudget(budgetId);
  }

  return actualApiClient;
}
