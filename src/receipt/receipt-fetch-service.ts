import ConnectorRegistry from './connector-registry';
import ReceiptStore from './receipt-store';
import { ReceiptDocument } from './types';

class ReceiptFetchService {
  private registry: ConnectorRegistry;
  private store: ReceiptStore;
  private fetchDaysBack: number;

  constructor(registry: ConnectorRegistry, store: ReceiptStore, fetchDaysBack: number) {
    this.registry = registry;
    this.store = store;
    this.fetchDaysBack = fetchDaysBack;
  }

  async fetchAll(): Promise<{
    fetched: number;
    incremental: boolean;
    errors: Array<{ provider: string; message: string }>;
  }> {
    const connectors = this.registry.getAll();
    let fetched = 0;
    let incremental = false;
    const errors: Array<{ provider: string; message: string }> = [];

    for (const connector of connectors) {
      // Record sync start time BEFORE fetching (so we don't miss receipts
      // that change during the fetch window)
      const syncStartTimestamp = new Date().toISOString().replace('T', ' ').split('.')[0];

      // Check for stored sync state — if we have one, do incremental sync
      const syncState = this.store.getSyncState(connector.providerId);
      const updatedSince = syncState?.lastSyncTimestamp;

      if (updatedSince) {
        incremental = true;
        console.log(
          `[receipt-fetch] ${connector.providerId}: incremental sync since ${updatedSince}`,
        );
      } else {
        console.log(
          `[receipt-fetch] ${connector.providerId}: initial full sync (no prior sync state)`,
        );
      }

      // The `since` Date is used as a fallback date filter for connectors
      // that don't support updatedSince. For Veryfi, updatedSince takes
      // precedence and `since` is ignored.
      const since = new Date(Date.now() - this.fetchDaysBack * 86_400_000);

      let result: {
        receipts: ReceiptDocument[];
        errors: Array<{ message: string; context?: unknown }>;
      };

      try {
        result = await connector.fetchReceipts(since, updatedSince);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ provider: connector.providerId, message });
        continue;
      }

      for (const receipt of result.receipts) {
        const duplicates = this.store.findNearDuplicates(
          receipt.vendorName,
          receipt.date,
          receipt.totalAmount,
          5,
        );

        if (duplicates.length > 0) {
          console.warn(
            `[receipt-fetch] Near-duplicate(s) found for ${receipt.vendorName} `
            + `${receipt.date} ${receipt.totalAmount}c — ${duplicates.length} existing record(s)`,
          );
        }

        this.store.upsertReceipt({
          externalId: receipt.externalId,
          providerId: receipt.providerId,
          vendorName: receipt.vendorName,
          vendorId: receipt.vendorId,
          totalAmount: receipt.totalAmount,
          date: receipt.date,
          currency: receipt.currency,
          lineItemCount: receipt.lineItems.length,
          taxAmount: receipt.taxAmount,
          receiptData: JSON.stringify(receipt),
          fetchedAt: new Date().toISOString(),
        });

        fetched++;
      }

      // Save sync state for next run
      this.store.setSyncState(connector.providerId, syncStartTimestamp, result.receipts.length);

      for (const connError of result.errors) {
        errors.push({ provider: connector.providerId, message: connError.message });
      }
    }

    console.log(
      `[receipt-fetch] Fetched ${fetched} receipts from ${connectors.length} connector(s)`
      + ` (${incremental ? 'incremental' : 'full'}, ${errors.length} errors)`,
    );

    return { fetched, incremental, errors };
  }
}

export default ReceiptFetchService;
