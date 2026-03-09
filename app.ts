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
import { transactionProcessor as txProcessor, receiptFetchService } from './src/container';
import ClassificationStore from './src/web/classification-store';
import { createWebServer } from './src/web/server';
import type { UnifiedResponse, APICategoryEntity, APICategoryGroupEntity } from './src/types';
import type { TransactionEntity } from '@actual-app/api/@types/loot-core/src/types/models';

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

  // Fetch receipts before classification when receipt matching is enabled
  if (isFeatureEnabled('receiptMatching')) {
    try {
      const result = await receiptFetchService.fetchAll();
      if (result.errors.length > 0) {
        console.warn(`Receipt fetch completed with ${result.errors.length} error(s)`);
      }
    } catch (err) {
      console.error('Receipt fetch failed (continuing with classification):', err);
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

// Helper to create a temporary API connection for applying classifications
async function createTempApiService(): Promise<typeof actualApiClient> {
  await actualApiClient.init({
    dataDir: dataDir + 'apply/',
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
