/** Veryfi internal API client — TypeScript port.
 *
 * Read-only client for iapi.veryfi.com/api/v7. Covers receipts, tags,
 * categories, payments, contacts, reports, currencies, and accounts.
 *
 * Ported from Python: veryfi/c-d-veryfi-knowledge-transfer/python-client/veryfi_client.py
 */

import {
  VeryfiCredentials,
  VeryfiProfile,
  VeryfiReceipt,
  VeryfiReceiptFilters,
  VeryfiLineItem,
  VeryfiMeta,
  VeryfiCategory,
  VeryfiTag,
} from './types';
import { authenticate, switchProfile as authSwitchProfile } from './auth';

// ── Errors ──────────────────────────────────────────────────────────

export class VeryfiError extends Error {
  constructor(message: string) { super(message); this.name = 'VeryfiError'; }
}

export class VeryfiSessionExpired extends VeryfiError {
  constructor() { super('Session expired. Re-authenticate to continue.'); this.name = 'VeryfiSessionExpired'; }
}

export class VeryfiAPIError extends VeryfiError {
  constructor(public statusCode: number, public body: string) {
    super(`HTTP ${statusCode}: ${body.slice(0, 300)}`);
    this.name = 'VeryfiAPIError';
  }
}

export class VeryfiRateLimited extends VeryfiAPIError {
  constructor(public retryAfter: number, body = '') {
    super(429, body || `Rate limited. Retry after ${retryAfter}s`);
    this.name = 'VeryfiRateLimited';
  }
}

// ── Type coercion ───────────────────────────────────────────────────

function toInt(val: unknown, fallback: number | null = null): number | null {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toFloat(val: unknown, fallback: number | null = null): number | null {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/** Normalise mixed-type fields on a receipt to consistent types.
 *
 * The Veryfi API returns inconsistent types for several fields:
 *   - business_id: int on 99%, str on 1%
 *   - business_lat/lng: float on 83%, str on 17%
 *   - total_user_adj: empty str on 99.5%, float on 0.5%
 */
function coerceReceiptTypes(receipt: Record<string, unknown>): VeryfiReceipt {
  if ('business_id' in receipt) {
    receipt.business_id = toInt(receipt.business_id);
  }
  for (const field of ['business_lat', 'business_lng', 'lat', 'lng', 'total_user_adj']) {
    if (field in receipt) {
      receipt[field] = toFloat(receipt[field]);
    }
  }
  return receipt as VeryfiReceipt;
}

// ── Client ──────────────────────────────────────────────────────────

export class VeryfiClient {
  private clientId: string;
  private veryfiSession: string;
  private baseUrl: string;
  private rateDelay: number;
  private lastRequest = 0;

  // Auth credentials for re-authentication on 401
  private authUsername?: string;
  private authPassword?: string;
  private authTotpSecret?: string;

  // Profile state
  private cookies: string;
  private profiles: VeryfiProfile[] | null = null;
  private activeProfile: VeryfiProfile | null = null;

  constructor(
    credentials: VeryfiCredentials,
    baseUrl = 'https://iapi.veryfi.com/api/v7',
    rateLimitRps = 1.0,
  ) {
    this.clientId = credentials.clientId;
    this.veryfiSession = credentials.veryfiSession;
    this.cookies = credentials.cookies;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.rateDelay = 1000 / rateLimitRps;
  }

  /** Enable automatic re-authentication on 401. */
  setAuthCredentials(username: string, password: string, totpSecret: string): void {
    this.authUsername = username;
    this.authPassword = password;
    this.authTotpSecret = totpSecret;
  }

  /** Update session after re-authentication. */
  updateCredentials(credentials: VeryfiCredentials): void {
    this.clientId = credentials.clientId;
    this.veryfiSession = credentials.veryfiSession;
  }

  // ── Internal helpers ────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      'client-id': this.clientId,
      'veryfi-session': this.veryfiSession,
      'accept': 'application/json',
      'origin': 'https://app.veryfi.com',
      'referer': 'https://app.veryfi.com/',
    };
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequest;
    if (elapsed < this.rateDelay) {
      const jitter = Math.random() * 300;
      await new Promise((r) => setTimeout(r, this.rateDelay - elapsed + jitter));
    }
    this.lastRequest = Date.now();
  }

  private async get(path: string, params?: Record<string, string | number>, maxRetries = 3): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await this.rateLimit();

      let resp: Response;
      try {
        resp = await fetch(url.toString(), {
          headers: this.headers(),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err: unknown) {
        if (attempt < maxRetries - 1) {
          const backoff = (2 ** attempt) * 1000 + Math.random() * 1000;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw new VeryfiAPIError(0, `Timeout after ${maxRetries} attempts: ${url}`);
      }

      if (resp.status === 200) {
        return await resp.json() as Record<string, unknown>;
      }

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '60', 10);
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        throw new VeryfiRateLimited(retryAfter, await resp.text());
      }

      if (resp.status === 401) {
        // Try re-auth once if credentials are available
        if (attempt === 0 && this.authUsername && this.authPassword && this.authTotpSecret) {
          const creds = await authenticate(this.authUsername, this.authPassword, this.authTotpSecret);
          this.updateCredentials(creds);
          continue;
        }
        throw new VeryfiSessionExpired();
      }

      if (resp.status >= 500 && attempt < maxRetries - 1) {
        const backoff = (2 ** attempt) * 1000 + Math.random() * 1000;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      throw new VeryfiAPIError(resp.status, await resp.text());
    }

    throw new VeryfiAPIError(0, `Failed after ${maxRetries} attempts`);
  }

  private async paginate<T>(
    path: string,
    resultKey: string,
    params: Record<string, string | number>,
    maxPages?: number,
  ): Promise<{ items: T[]; meta: VeryfiMeta }> {
    const allItems: T[] = [];
    let firstMeta: VeryfiMeta | null = null;
    let pagesFetched = 0;

    while (true) {
      const data = await this.get(path, params);
      const items = (data[resultKey] ?? []) as T[];
      const meta = (data.meta ?? {}) as VeryfiMeta;

      if (!firstMeta) firstMeta = meta;
      if (items.length === 0) break;

      allItems.push(...items);
      pagesFetched++;

      const currentPage = meta.page_number ?? Number(params.page ?? 1);
      const totalPages = meta.total_pages ?? 0;

      if (currentPage >= totalPages) break;
      if (maxPages && pagesFetched >= maxPages) break;

      params.page = currentPage + 1;
    }

    return { items: allItems, meta: firstMeta ?? {} as VeryfiMeta };
  }

  // ── Receipts ────────────────────────────────────────────────────

  /** Fetch receipts matching filters (auto-paginates).
   *
   * Returns receipts with mixed-type fields coerced to consistent types.
   *
   * Data quality notes:
   *   - total != subtotal + tax + tip - discount + shipping on ~46% of receipts
   *   - Use business_id (int) to deduplicate vendors, not business_name
   *   - line_items[].price is zero 84% of the time — use .total instead
   *   - line_items[].tax is always 0 — tax only at receipt level
   */
  async getReceipts(filters: VeryfiReceiptFilters = {}): Promise<{ receipts: VeryfiReceipt[]; meta: VeryfiMeta }> {
    const params: Record<string, string | number> = {
      page_size: filters.pageSize ?? 50,
      page: 1,
      orderby: filters.orderby ?? '-created',
    };

    if (filters.startDate) {
      params.start_date = filters.startDate;
      params.date_type = filters.dateType ?? 'created';
    }
    if (filters.endDate) params.end_date = filters.endDate;
    if (filters.tag) params.tag = filters.tag;        // singular! not tags=
    if (filters.status) params.status = filters.status;
    if (filters.vendor) params.vendor = filters.vendor;
    if (filters.q) params.q = filters.q;
    if (filters.category) params.category = filters.category;
    if (filters.documentType) params.document_type = filters.documentType;
    if (filters.accountingEntryType) params.accounting_entry_type = filters.accountingEntryType;

    const { items, meta } = await this.paginate<Record<string, unknown>>(
      '/receipts/',
      'receipts',
      params,
      filters.maxPages,
    );

    const receipts = items.map((r) => coerceReceiptTypes(r));
    return { receipts, meta };
  }

  /** Fetch a single receipt by ID (includes full line_items). */
  async getReceipt(receiptId: number): Promise<VeryfiReceipt> {
    const data = await this.get(`/receipts/${receiptId}/`);
    return coerceReceiptTypes(data);
  }

  // ── Tags ────────────────────────────────────────────────────────

  /** Fetch all tags. Note: receipts_count can be stale. */
  async getTags(pageSize = 100): Promise<VeryfiTag[]> {
    const { items } = await this.paginate<VeryfiTag>(
      '/tags/', 'tags', { page_size: pageSize, page: 1 },
    );
    return items;
  }

  /** Fetch a single tag by ID. */
  async getTag(tagId: number): Promise<VeryfiTag> {
    return await this.get(`/tags/${tagId}/`) as unknown as VeryfiTag;
  }

  // ── Categories ──────────────────────────────────────────────────

  /** Fetch all expense categories (not paginated, ~84 items). */
  async getCategories(): Promise<VeryfiCategory[]> {
    const data = await this.get('/categories/');
    return (data.categories ?? []) as VeryfiCategory[];
  }

  // ── Payments ────────────────────────────────────────────────────

  async getPayments(): Promise<Record<string, unknown>[]> {
    const data = await this.get('/payments/');
    return (data.payments ?? []) as Record<string, unknown>[];
  }

  // ── Contacts ────────────────────────────────────────────────────

  async getContacts(pageSize = 100): Promise<Record<string, unknown>[]> {
    const { items } = await this.paginate<Record<string, unknown>>(
      '/contacts/', 'contacts', { page_size: pageSize, page: 1 },
    );
    return items;
  }

  // ── Reports ─────────────────────────────────────────────────────

  async getReports(): Promise<Record<string, unknown>[]> {
    const data = await this.get('/reports/');
    return (data.reports ?? []) as Record<string, unknown>[];
  }

  // ── Currencies ──────────────────────────────────────────────────

  async getCurrencies(): Promise<Record<string, unknown>[]> {
    const data = await this.get('/currencies/');
    return (data.currencies ?? []) as Record<string, unknown>[];
  }

  // ── Accounts ────────────────────────────────────────────────────

  async getAccounts(): Promise<Record<string, unknown>[]> {
    const data = await this.get('/accounts/');
    return (data.accounts ?? []) as Record<string, unknown>[];
  }

  // ── Profiles ──────────────────────────────────────────────────────

  /** List available profiles with fields needed for switching.
   *  Results are cached after the first call. Pass refresh=true to reload. */
  async getProfiles(refresh = false): Promise<VeryfiProfile[]> {
    if (this.profiles !== null && !refresh) {
      return this.profiles;
    }

    const accounts = await this.getAccounts();
    this.profiles = accounts.map((a) => ({
      username: a.username as string,
      apiKey: (a.api_key as string) ?? '',
      companyName: (a.company_name as string) ?? '',
      accountId: a.id as number,
      companyId: (a.company as Record<string, unknown>)?.id as number | undefined,
      isPrimary: Boolean(a.is_primary),
      type: (a.type as string) ?? '',
      displayType: (a.display_type as string) ?? '',
    }));
    return this.profiles;
  }

  /** Get the currently active profile (set after switchProfile). */
  getActiveProfile(): VeryfiProfile | null {
    return this.activeProfile;
  }

  /** Find a profile by username, company name substring, or account ID. */
  async resolveProfile(identifier: string): Promise<VeryfiProfile> {
    const profiles = await this.getProfiles();

    // Exact username match
    for (const p of profiles) {
      if (p.username === identifier) return p;
    }

    // Account ID match
    const aid = parseInt(identifier, 10);
    if (Number.isFinite(aid)) {
      for (const p of profiles) {
        if (p.accountId === aid) return p;
      }
    }

    // Case-insensitive company name substring match
    const lower = identifier.toLowerCase();
    const matches = profiles.filter(
      (p) => p.companyName.toLowerCase().includes(lower),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const names = matches.map((m) => m.companyName);
      throw new VeryfiError(
        `Ambiguous profile '${identifier}' matches ${matches.length} profiles: ${names.join(', ')}. Use the exact username instead.`,
      );
    }

    const available = profiles.map(
      (p) => `${p.username} (${p.companyName})`,
    );
    throw new VeryfiError(
      `No profile matching '${identifier}'. Available: ${available.join(', ')}`,
    );
  }

  /** Switch to a different profile. All subsequent API calls will use the new profile. */
  async switchProfile(identifier: string): Promise<VeryfiProfile> {
    const profile = await this.resolveProfile(identifier);

    const newCreds = await authSwitchProfile(
      this.cookies,
      profile.username,
      profile.apiKey,
    );

    this.clientId = newCreds.clientId;
    this.veryfiSession = newCreds.veryfiSession;
    this.activeProfile = profile;

    console.log(`Veryfi: switched to profile '${profile.companyName}' (${profile.username})`);
    return profile;
  }

  // ── Health check ────────────────────────────────────────────────

  /** Test connection by fetching first page of receipts (1 item). */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const { meta } = await this.getReceipts({ pageSize: 1, maxPages: 1 });
      return {
        ok: true,
        message: `Connected. ${meta.total_results} total receipts.`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg };
    }
  }
}
