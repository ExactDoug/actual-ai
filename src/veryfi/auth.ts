/** Veryfi automated login with MFA (TOTP) — TypeScript port.
 *
 * Performs the 5-step browser login flow:
 *   1. GET  /auth/login/       → extract CSRF token from <meta> tag
 *   2. POST /api/auth/login/   → multipart form with credentials
 *   3. GET  /auth/mfa/         → extract CSRF, mfa_type, request_id
 *   4. POST /api/auth/mfa/     → submit TOTP code
 *   5. GET  /dashboard/        → extract client-id + veryfi-session from IQBOXY JS
 *
 * Ported from Python: veryfi/c-d-veryfi-knowledge-transfer/python-client/veryfi_auth.py
 */

import * as crypto from 'crypto';
import { VeryfiCredentials } from './types';

const APP_URL = 'https://app.veryfi.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';

// ── TOTP implementation (no external dependency) ────────────────────

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/[=\s]/g, '').toUpperCase();
  let bits = '';
  for (const c of cleaned) {
    const val = BASE32_CHARS.indexOf(c);
    if (val === -1) throw new Error(`Invalid base32 character: ${c}`);
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTOTP(secret: string, interval = 30, digits = 6): string {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / interval);

  // counter as 8-byte big-endian
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % (10 ** digits);

  return code.toString().padStart(digits, '0');
}

/** Seconds remaining in the current TOTP window. */
function totpRemaining(interval = 30): number {
  return interval - (Math.floor(Date.now() / 1000) % interval);
}

// ── Cookie jar (minimal, single-domain) ─────────────────────────────

class CookieJar {
  private cookies: Map<string, string> = new Map();

  /** Parse set-cookie headers from a fetch Response. */
  capture(response: Response): void {
    // getSetCookie() returns individual set-cookie header values (Node 20+)
    const setCookies = (response.headers as any).getSetCookie?.()
      ?? [response.headers.get('set-cookie')].filter(Boolean);

    for (const header of setCookies) {
      if (!header) continue;
      // Extract name=value before the first ;
      const parts = (header as string).split(';')[0].trim();
      const eqIdx = parts.indexOf('=');
      if (eqIdx > 0) {
        this.cookies.set(parts.slice(0, eqIdx), parts.slice(eqIdx + 1));
      }
    }
  }

  /** Format cookies for the Cookie request header. */
  toString(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractMeta(html: string, name: string): string {
  const re = new RegExp(`<meta name="${name}" content="([^"]+)"`);
  const m = html.match(re);
  if (!m) throw new Error(`Meta tag "${name}" not found in page`);
  return m[1];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelay(lowMs = 500, highMs = 2000): Promise<void> {
  return delay(lowMs + Math.random() * (highMs - lowMs));
}

// ── Main auth flow ──────────────────────────────────────────────────

export async function authenticate(
  username: string,
  password: string,
  totpSecret: string,
): Promise<VeryfiCredentials> {
  const jar = new CookieJar();

  // Step 1: GET login page → extract CSRF token
  const r1 = await fetch(`${APP_URL}/auth/login/`, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
  });
  if (!r1.ok) throw new Error(`Login page failed: HTTP ${r1.status}`);
  jar.capture(r1);
  const html1 = await r1.text();
  const csrf1 = extractMeta(html1, 'csrf-token');

  // Step 2: POST login (multipart/form-data)
  // CRITICAL: must be multipart/form-data, not JSON or URL-encoded
  await humanDelay(1500, 3500);
  const loginForm = new FormData();
  loginForm.append('username', username);
  loginForm.append('password', password);
  loginForm.append('is_newly_verified', 'false');
  loginForm.append('next_url', '');
  loginForm.append('lat_lng', '');
  loginForm.append('country_code', '');
  loginForm.append('timezone', '');
  loginForm.append('user_agent', USER_AGENT);
  loginForm.append('ip_address', '');

  const r2 = await fetch(`${APP_URL}/api/auth/login/`, {
    method: 'POST',
    body: loginForm,
    headers: {
      'x-csrftoken': csrf1,
      'referer': `${APP_URL}/auth/login/`,
      'accept': 'application/json, text/plain, */*',
      'origin': APP_URL,
      'user-agent': USER_AGENT,
      'cookie': jar.toString(),
    },
  });
  jar.capture(r2);
  const loginResp = await r2.json() as Record<string, unknown>;
  if (!loginResp.success) {
    throw new Error(`Login failed: ${JSON.stringify(loginResp.errors ?? loginResp)}`);
  }

  // Step 3: GET MFA page → extract CSRF, mfa_type, request_id
  await humanDelay(500, 1500);
  const r3 = await fetch(`${APP_URL}/auth/mfa/`, {
    headers: {
      'user-agent': USER_AGENT,
      'cookie': jar.toString(),
    },
    redirect: 'follow',
  });
  if (!r3.ok) throw new Error(`MFA page failed: HTTP ${r3.status}`);
  jar.capture(r3);
  const html3 = await r3.text();
  const csrf2 = extractMeta(html3, 'csrf-token');
  const mfaType = extractMeta(html3, 'mfa-type');
  const requestId = extractMeta(html3, 'request-id');

  // Step 4: POST MFA with TOTP code
  // Wait for a fresh TOTP window if less than 12 seconds remaining
  const remaining = totpRemaining();
  if (remaining < 12) {
    const waitMs = (remaining + 1 + Math.random() * 2) * 1000;
    await delay(waitMs);
  }
  await humanDelay(1000, 2000);

  const code = generateTOTP(totpSecret);
  const mfaForm = new FormData();
  mfaForm.append('code', code);
  mfaForm.append('validate_mfa', '1'); // MUST be "1", not "true"
  mfaForm.append('mfa_type', mfaType);
  mfaForm.append('request_id', requestId);

  const r4 = await fetch(`${APP_URL}/api/auth/mfa/`, {
    method: 'POST',
    body: mfaForm,
    headers: {
      'x-csrftoken': csrf2,
      'referer': `${APP_URL}/auth/mfa/`,
      'accept': 'application/json, text/plain, */*',
      'origin': APP_URL,
      'user-agent': USER_AGENT,
      'cookie': jar.toString(),
    },
  });
  jar.capture(r4);
  const mfaResp = await r4.json() as Record<string, unknown>;
  if (!mfaResp.success) {
    throw new Error(`MFA failed: ${mfaResp.error_message ?? JSON.stringify(mfaResp)}`);
  }

  // Step 5: GET dashboard → extract client-id + veryfi-session from IQBOXY JS
  await humanDelay(500, 2000);
  const r5 = await fetch(`${APP_URL}/dashboard/`, {
    headers: {
      'user-agent': USER_AGENT,
      'cookie': jar.toString(),
    },
    redirect: 'follow',
  });
  if (!r5.ok) throw new Error(`Dashboard page failed: HTTP ${r5.status}`);
  jar.capture(r5);
  const html5 = await r5.text();

  const cidMatch = html5.match(/IQBOXY\.API_CLIENT_ID='([^']+)'/);
  const sessMatch = html5.match(/IQBOXY\.API\.init\("[^"]+","([^"]+)"\)/);

  if (!cidMatch || !sessMatch) {
    throw new Error('Could not extract API credentials from dashboard');
  }

  return {
    clientId: cidMatch[1],
    veryfiSession: sessMatch[1],
    cookies: jar.toString(),
    authenticatedAt: Date.now(),
  };
}
