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
    errors: Array<{ provider: string; message: string }>;
  }> {
    const since = new Date(Date.now() - this.fetchDaysBack * 86_400_000);
    const connectors = this.registry.getAll();
    let fetched = 0;
    const errors: Array<{ provider: string; message: string }> = [];

    for (const connector of connectors) {
      let result: {
        receipts: ReceiptDocument[];
        errors: Array<{ message: string; context?: unknown }>;
      };

      try {
        result = await connector.fetchReceipts(since);
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
            `[receipt-fetch] Near-duplicate(s) found for ${receipt.vendorName} ` +
            `${receipt.date} ${receipt.totalAmount}c — ${duplicates.length} existing record(s)`,
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

      for (const connError of result.errors) {
        errors.push({ provider: connector.providerId, message: connError.message });
      }
    }

    console.log(
      `[receipt-fetch] Fetched ${fetched} receipts from ${connectors.length} connectors (${errors.length} errors)`,
    );

    return { fetched, errors };
  }
}

export default ReceiptFetchService;
