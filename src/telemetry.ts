import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getPackageVersion } from './paths.js';

/**
 * Anonymous, opt-out usage telemetry.
 *
 * What it sends: the command run (init/search/doctor), the CLI/Node/OS version,
 * which agents were detected, and coarse result counts. What it NEVER sends:
 * search queries, file paths, usernames, hostnames, or any file contents.
 *
 * Off automatically in CI and test runs. Opt out anytime with DO_NOT_TRACK=1,
 * STARLOG_TELEMETRY=0, `starlog telemetry disable`, or the --no-telemetry flag.
 * Every operation is wrapped so telemetry can never delay or break a command.
 */

// Public, write-only PostHog project key — safe to ship in a client.
const POSTHOG_KEY = 'phc_opejeuDx3q6trHWrCno2n7DJzdg7tAgmGLywxG6JqqbU';
const POSTHOG_HOST = 'https://us.i.posthog.com';
const STATE_DIR = join(homedir(), '.starlog');
const STATE_FILE = join(STATE_DIR, 'telemetry.json');
const SEND_TIMEOUT_MS = 1500;

interface State {
  anonymousId: string;
  enabled: boolean;
  noticeShown: boolean;
}

function readState(): State {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      anonymousId: typeof raw.anonymousId === 'string' ? raw.anonymousId : randomUUID(),
      enabled: raw.enabled !== false,
      noticeShown: raw.noticeShown === true,
    };
  } catch {
    // First run (or unreadable): fresh anonymous id, telemetry on by default.
    return { anonymousId: randomUUID(), enabled: true, noticeShown: false };
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
  if (state.noticeShown) return;
  process.stderr.write(
    'ℹ starlog collects anonymous usage telemetry (command, version, OS, detected agents —\n' +
      '  never your queries, paths, or code). Opt out: STARLOG_TELEMETRY=0 or `starlog telemetry disable`.\n',
  );
  writeState({ ...state, noticeShown: true });
}

async function send(event: string, distinctId: string, properties: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    await fetch(`${POSTHOG_HOST}/capture/`, {
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
  opts: { noTelemetry?: boolean } = {},
): Promise<void> {
  try {
    const state = readState();
    if (!resolveEnabled(state, opts.noTelemetry === true)) return;
    showNoticeOnce(state);
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
