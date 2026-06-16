import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getPackageVersion } from './paths.js';

/**
 * Anonymous, opt-out usage telemetry.
 *
 * What it sends: the command/tool run, the CLI/Node/OS version, detected agents,
 * coarse result counts, and — for product analytics — the PUBLIC package names
 * looked up and the search queries / project context, with emails, secrets,
 * absolute paths, and IPs scrubbed first (see {@link scrubText}). What it NEVER
 * sends: org-PRIVATE package names (redacted to a boolean), usernames/hostnames,
 * or file contents.
 *
 * Off automatically in CI and test runs. Opt out anytime with DO_NOT_TRACK=1,
 * STARLOG_TELEMETRY=0, `starlog telemetry disable`, or the --no-telemetry flag.
 * Every operation is wrapped so telemetry can never delay or break a command.
 * The notice is re-shown when {@link NOTICE_VERSION} increases (re-consent on what
 * changed), so an upgrade that broadens collection cannot do so silently.
 */

// Public, write-only PostHog project key — safe to ship in a client.
const POSTHOG_KEY = 'phc_opejeuDx3q6trHWrCno2n7DJzdg7tAgmGLywxG6JqqbU';
const POSTHOG_HOST = 'https://us.i.posthog.com';
const STATE_DIR = join(homedir(), '.starlog');
const STATE_FILE = join(STATE_DIR, 'telemetry.json');
const SEND_TIMEOUT_MS = 1500;

/**
 * Bump when the DISCLOSURE changes (what we collect), not on every release. A
 * stored version below this re-shows {@link TELEMETRY_NOTICE} on the next run, so
 * broadening collection always re-consents. v2 = added public package names +
 * scrubbed search queries / project context (was: command/version/OS only).
 */
export const NOTICE_VERSION = 2;

/** The first-run / on-upgrade disclosure. Must stay truthful about what is sent. */
export const TELEMETRY_NOTICE =
  'ℹ starlog collects anonymous, opt-out usage analytics: the command/tool run, version & OS,\n' +
  '  detected agents, result counts, the PUBLIC package names you look up, and your search\n' +
  '  queries / project context (emails, secrets, file paths, and IPs are scrubbed first).\n' +
  '  It never sends your org-private package names, usernames, or file contents.\n' +
  '  Opt out: STARLOG_TELEMETRY=0, DO_NOT_TRACK=1, or `starlog telemetry disable`.\n';

interface State {
  anonymousId: string;
  enabled: boolean;
  /** Highest NOTICE_VERSION the user has been shown (0 = never / legacy install). */
  noticeVersion: number;
}

/** Pure: normalize a parsed telemetry.json into State. Legacy files (no version) → 0. */
export function parseState(raw: unknown): State {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    anonymousId: typeof o.anonymousId === 'string' ? o.anonymousId : randomUUID(),
    enabled: o.enabled !== false,
    noticeVersion: typeof o.noticeVersion === 'number' ? o.noticeVersion : 0,
  };
}

/** Pure: has this user yet to see the CURRENT disclosure? */
export function needsNotice(state: State): boolean {
  return state.noticeVersion < NOTICE_VERSION;
}

function readState(): State {
  try {
    return parseState(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
  } catch {
    // First run (or unreadable): fresh anonymous id, telemetry on by default.
    return { anonymousId: randomUUID(), enabled: true, noticeVersion: 0 };
  }
}

function writeState(state: State): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Read-only home / permissions — telemetry just won't persist. Fine.
  }
}

/** Sentinel substituted for any redacted span in free-text telemetry. */
const REDACTED = '‹redacted›';

/**
 * Redact PII and secrets from free-text telemetry (search queries, project
 * context) before it ever reaches PostHog. Benign developer text — capability
 * queries, package names — passes through untouched (it's the product signal we
 * want); emails, tokens, absolute paths, and IPs are replaced with {@link REDACTED}.
 * Pure + exhaustively unit-tested; this is the load-bearing privacy guard.
 */
export function scrubText(s: string): string {
  if (!s) return s;
  const patterns: RegExp[] = [
    /[\w.+-]+@[\w-]+\.[\w.-]+/g, // email
    /Bearer\s+[\w.\-+/=]+/gi, // bearer token
    /gh[pousr]_[A-Za-z0-9]{20,}/g, // github token
    /sk-[A-Za-z0-9]{20,}/g, // openai-style key
    /AKIA[0-9A-Z]{16}/g, // aws access key id
    /[A-Za-z]:\\[\w\\.-]+/g, // windows path
    /(?:~\/|\/)[\w.-]+(?:\/[\w.-]+)+/g, // unix / ~ absolute path (>=2 segments; spares "and/or")
    /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, // ipv4
    /\b[A-Za-z0-9+/]{32,}={0,2}\b/g, // long secret blob (last — most general)
  ];
  return patterns.reduce((acc, re) => acc.replace(re, REDACTED), s);
}

function isTruthy(v: string | undefined): boolean {
  return v != null && /^(1|true|yes|on)$/i.test(v);
}
function isFalsy(v: string | undefined): boolean {
  return v != null && /^(0|false|no|off)$/i.test(v);
}

/** Resolve whether telemetry should run, honoring env + flags + persisted state. */
function resolveEnabled(state: State, noTelemetryFlag: boolean): boolean {
  if (noTelemetryFlag) return false;
  if (isTruthy(process.env.DO_NOT_TRACK)) return false;
  if (isFalsy(process.env.STARLOG_TELEMETRY)) return false;
  if (isTruthy(process.env.STARLOG_TELEMETRY)) return true; // explicit opt-in overrides CI/test guard
  if (process.env.CI) return false; // don't pollute "real install" data with CI
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return false;
  return state.enabled;
}

function showNoticeOnce(state: State): void {
  if (!needsNotice(state)) return;
  process.stderr.write(TELEMETRY_NOTICE);
  writeState({ ...state, noticeVersion: NOTICE_VERSION });
}

async function send(event: string, distinctId: string, properties: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  // Host is overridable (self-hosted PostHog; redirected to a local sink in tests).
  const host = process.env.STARLOG_TELEMETRY_HOST || POSTHOG_HOST;
  try {
    await fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: distinctId,
        properties: {
          $lib: 'starlog-cli',
          starlog_version: getPackageVersion(),
          node_version: process.version,
          os: platform(),
          arch: arch(),
          ...properties,
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire one telemetry event. Never throws, never blocks meaningfully (capped at
 * SEND_TIMEOUT_MS). Safe to `await` at the end of a command.
 */
export async function track(
  event: string,
  properties: Record<string, unknown> = {},
  opts: { noTelemetry?: boolean; surface?: 'cli' | 'mcp' } = {},
): Promise<void> {
  try {
    const state = readState();
    if (!resolveEnabled(state, opts.noTelemetry === true)) return;
    if (opts.surface === 'mcp') {
      // The MCP server's stderr goes to the agent host's logs, not the human, so
      // it can neither show the disclosure nor count as consent. Capture ONLY once
      // the current notice has been acknowledged via a human-visible CLI run; never
      // display or bump the notice here (that would silently "consume" consent).
      if (needsNotice(state)) return;
    } else {
      showNoticeOnce(state);
    }
    await send(event, state.anonymousId, properties);
  } catch {
    // Telemetry must be invisible on failure.
  }
}

/** Backing for the `starlog telemetry` command. */
export function telemetryStatus(): { enabled: boolean; anonymousId: string; file: string } {
  const s = readState();
  return { enabled: resolveEnabled(s, false), anonymousId: s.anonymousId, file: STATE_FILE };
}

export function setTelemetryEnabled(enabled: boolean): void {
  const s = readState();
  writeState({ ...s, enabled });
}

/**
 * The anonymous id to relay to the hosted API (header `X-Starlog-Anon-Id`) so
 * the server can alias this CLI install to the GitHub person at key issuance.
 * Returns null when telemetry is disabled — same opt-out contract as every
 * other event (DO_NOT_TRACK / STARLOG_TELEMETRY=0 / CI / test), so an opted-out
 * user relays nothing.
 */
export function telemetryAnonId(): string | null {
  const s = readState();
  return resolveEnabled(s, false) ? s.anonymousId : null;
}
