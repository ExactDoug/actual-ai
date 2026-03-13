/** VeryfiAdapter — implements ReceiptConnector using the Veryfi internal API client.
 *
 * Wraps VeryfiClient to fetch receipts and normalize them into ReceiptDocument format.
 * All monetary amounts are converted from dollars (float) to cents (integer).
 */

import { ReceiptConnector, ReceiptDocument, ReceiptLineItem } from './types';
import { VeryfiClient } from '../veryfi/client';
import { authenticate } from '../veryfi/auth';
import { VeryfiCredentials, VeryfiReceipt, VeryfiLineItem } from '../veryfi/types';

class VeryfiAdapter implements ReceiptConnector {
  readonly providerId = 'veryfi';

  private readonly username: string;
  private readonly password: string;
  private readonly totpSecret: string;

  private client: VeryfiClient | null = null;
  private credentials: VeryfiCredentials | null = null;

  constructor(username: string, password: string, totpSecret: string) {
    this.username = username;
    this.password = password;
    this.totpSecret = totpSecret;
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /** Authenticate if we don't already have valid credentials, then
   *  lazily create or update the VeryfiClient. */
  private async ensureClient(): Promise<VeryfiClient> {
    if (!this.credentials) {
      this.credentials = await authenticate(this.username, this.password, this.totpSecret);
    }

    if (!this.client) {
      this.client = new VeryfiClient(this.credentials);
      this.client.setAuthCredentials(this.username, this.password, this.totpSecret);
    }

    return this.client;
  }

  /** Convert a VeryfiReceipt's stamp_date (or fallback) to YYYY-MM-DD. */
  private static parseDate(receipt: VeryfiReceipt): string {
    // Primary: stamp_date is the OCR date from the receipt.
    // It may be "2026-02-23 15:46:20" (datetime) or "2026-02-23" (date only).
    if (receipt.stamp_date) {
      const datePart = receipt.stamp_date.split(' ')[0];
      if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
        return datePart;
      }
    }

    // Fallback: created timestamp (ISO-ish: "2026-03-08 21:06:20" or with T separator)
    if (receipt.created) {
      const datePart = receipt.created.split('T')[0].split(' ')[0];
      if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
        return datePart;
      }
    }

    // Last resort: today
    return new Date().toISOString().split('T')[0];
  }

  /** Convert a VeryfiLineItem to the normalized ReceiptLineItem format. */
  private static mapLineItem(item: VeryfiLineItem): ReceiptLineItem {
    return {
      description: item.description ?? '',
      quantity: item.quantity ?? 1,
      unitPrice: Math.round((item.price ?? 0) * 100),
      // Use item.total, not item.price — 84% of price values are zero.
      totalPrice: Math.round((item.total ?? 0) * 100),
      category: item.category?.name,
      // Veryfi's per-item tax/tax_rate are always 0 and the type field is
      // unreliable at mixed-merchandise stores (e.g. greeting cards at grocery
      // stores get typed as "food"). Leave taxable null and let the LLM infer
      // taxability from item descriptions and NM tax rules.
      taxable: null,
    };
  }

  /** Convert a VeryfiReceipt to the normalized ReceiptDocument format. */
  private mapReceipt(receipt: VeryfiReceipt): ReceiptDocument {
    const lineItems: ReceiptLineItem[] = (receipt.line_items ?? []).map(
      (item) => VeryfiAdapter.mapLineItem(item),
    );

    return {
      externalId: String(receipt.id),
      providerId: this.providerId,
      vendorName: receipt.business_name ?? '',
      vendorId: receipt.business_id != null ? String(receipt.business_id) : undefined,
      date: VeryfiAdapter.parseDate(receipt),
      currency: receipt.currency_code ?? 'USD',
      totalAmount: Math.round((receipt.total ?? 0) * 100),
      subtotalAmount: Math.round((receipt.subtotal ?? 0) * 100),
      taxAmount: Math.round((receipt.tax ?? 0) * 100),
      tipAmount: Math.round((receipt.tip ?? 0) * 100),
      discountAmount: Math.round((receipt.discount ?? 0) * 100),
      shippingAmount: Math.round((receipt.shipping ?? 0) * 100),
      lineItems,
      rawData: receipt,
      imageUrl: receipt.img ?? receipt.pdf,
    };
  }

  // ── ReceiptConnector interface ────────────────────────────────────

  async fetchReceipts(since: Date): Promise<{
    receipts: ReceiptDocument[];
    errors: Array<{ message: string; context?: unknown }>;
  }> {
    const client = await this.ensureClient();

    const startDate = since.toISOString().split('T')[0]; // YYYY-MM-DD

    const { receipts: veryfiReceipts } = await client.getReceipts({
      startDate,
      dateType: 'created',
      orderby: '-created',
    });

    const receipts: ReceiptDocument[] = [];
    const errors: Array<{ message: string; context?: unknown }> = [];

    for (const raw of veryfiReceipts) {
      try {
        receipts.push(this.mapReceipt(raw));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({
          message: `Failed to map receipt id=${raw.id}: ${message}`,
          context: { receiptId: raw.id, error: err },
        });
      }
    }

    return { receipts, errors };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const client = await this.ensureClient();
      return await client.testConnection();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }
}

export default VeryfiAdapter;
