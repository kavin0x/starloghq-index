import {
  L1CapabilityFactSchema,
  L2OverlaySchema,
  L3PolicySchema,
  type Ecosystem,
  type L1CapabilityFact,
  type L2Overlay,
  type L3Policy,
} from '@starloghq/facts-schema';
import { telemetryAnonId } from '../../telemetry.js';
import { getUserAgent } from '../../paths.js';

/**
 * Client for the hosted facts API (the starlog-api worker). Matches the
 * `/search` consumption conventions: Bearer STARLOG_API_KEY, 10s abort,
 * defensive parsing, never throws to the caller (errors → null → local
 * fallback). See docs/FACTS-CONTRACT.md for the envelope.
 *
 * Endpoints (per the sy5 backend plan):
 *   GET  /facts?package=&ecosystem=  → { l1, l2, l3, found }   (l3 = org POLICY)
 *   POST /facts/l2                   → upsert org-private L2 overlays
 *   POST /facts/policy               → set the org L3 policy
 */

const DEFAULT_BASE_URL = 'https://api.starlog.dev';
const DEFAULT_TIMEOUT_MS = 10_000;

/** The GET /facts envelope — three independent inputs the client composes. */
export interface FactsApiResponse {
  l1: L1CapabilityFact | null;
  l2: L2Overlay | null; // public ⊕ org-private, private-wins resolved server-side
  l3: L3Policy | null; // the org POLICY (client runs evaluatePolicy), not a verdict
  found: boolean;
}

export interface PushResult {
  ok: boolean;
  count?: number;
  error?: string;
}

export interface FactsApiClient {
  getFacts(pkg: string, ecosystem?: Ecosystem): Promise<FactsApiResponse | null>;
  pushL2(overlays: L2Overlay[]): Promise<PushResult>;
  pushPolicy(policy: L3Policy): Promise<PushResult>;
}

function parseLayer<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, v: unknown): T | null {
  if (v === null || v === undefined) return null;
  const r = schema.safeParse(v);
  return r.success ? (r.data as T) : null;
}

/**
 * Defensive envelope reader — never assumes a bare record. Reads `.l1/.l2/.l3`,
 * validates each layer independently (a malformed layer → null, not a throw),
 * and derives `found` from the payload (or the presence of any layer).
 * Exported + unit-tested so the client and the worker agree on the shape.
 */
export function parseFactsApiResponse(json: unknown): FactsApiResponse {
  const obj = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const l1 = parseLayer<L1CapabilityFact>(L1CapabilityFactSchema, obj.l1);
  const l2 = parseLayer<L2Overlay>(L2OverlaySchema, obj.l2);
  const l3 = parseLayer<L3Policy>(L3PolicySchema, obj.l3);
  const found = typeof obj.found === 'boolean' ? obj.found : l1 !== null || l2 !== null;
  return { l1, l2, l3, found };
}

class FactsApiClientImpl implements FactsApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly anonId: string | null,
  ) {}

  private async req(path: string, init?: RequestInit): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': getUserAgent(),
          // Relay the anonymous CLI id so the server can alias this install to
          // the GitHub person at key issuance. Omitted entirely when telemetry
          // is opted out (anonId === null).
          ...(this.anonId ? { 'X-Starlog-Anon-Id': this.anonId } : {}),
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[starlog] facts API request failed (${msg}); using local facts.`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async getFacts(pkg: string, ecosystem?: Ecosystem): Promise<FactsApiResponse | null> {
    const params = new URLSearchParams({ package: pkg });
    if (ecosystem) params.set('ecosystem', ecosystem);
    const res = await this.req(`/facts?${params}`);
    if (!res) return null;
    if (!res.ok) {
      console.error(`[starlog] facts API error ${res.status} ${res.statusText}; using local facts.`);
      return null;
    }
    try {
      return parseFactsApiResponse(await res.json());
    } catch {
      console.error('[starlog] facts API returned an unreadable body; using local facts.');
      return null;
    }
  }

  async pushL2(overlays: L2Overlay[]): Promise<PushResult> {
    if (overlays.length === 0) return { ok: true, count: 0 };
    const res = await this.req('/facts/l2', { method: 'POST', body: JSON.stringify({ overlays }) });
    if (!res) return { ok: false, error: 'network error' };
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
    return { ok: true, count: overlays.length };
  }

  async pushPolicy(policy: L3Policy): Promise<PushResult> {
    const res = await this.req('/facts/policy', { method: 'POST', body: JSON.stringify(policy) });
    if (!res) return { ok: false, error: 'network error' };
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
    return { ok: true };
  }
}

/**
 * Build a facts API client, or null when no key is configured (callers treat
 * null as "local only"). baseUrl defaults to STARLOG_API_URL or api.starlog.dev.
 */
export function createFactsApiClient(
  opts: { apiKey?: string; baseUrl?: string; timeoutMs?: number; anonId?: string | null } = {},
): FactsApiClient | null {
  const apiKey = opts.apiKey ?? process.env.STARLOG_API_KEY;
  if (!apiKey) return null;
  const baseUrl = opts.baseUrl ?? process.env.STARLOG_API_URL ?? DEFAULT_BASE_URL;
  // Default the relay id from telemetry (null when opted out); tests inject it.
  const anonId = opts.anonId !== undefined ? opts.anonId : telemetryAnonId();
  return new FactsApiClientImpl(apiKey, baseUrl, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, anonId);
}
