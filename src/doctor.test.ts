import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson } from './doctor.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'starlog-doctor-test-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('readJson() — distinguishes absent from invalid (M6)', () => {
  it('returns {kind: "absent"} when the file does not exist', async () => {
    const res = await readJson(join(tmpRoot, 'nope.json'));
    expect(res).toEqual({ kind: 'absent' });
  });

  it('returns {kind: "ok", data} for valid JSON', async () => {
    const p = join(tmpRoot, 'settings.json');
    await writeFile(p, JSON.stringify({ mcpServers: { starlog: {} } }));
    const res = await readJson(p);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.data.mcpServers).toBeDefined();
    }
  });

  it('returns {kind: "invalid", error} for malformed JSON (NOT confused with absent)', async () => {
    const p = join(tmpRoot, 'settings.json');
    await writeFile(p, '{ broken json ');
    const res = await readJson(p);
    expect(res.kind).toBe('invalid');
    if (res.kind === 'invalid') {
      expect(res.error).toBeTruthy();
    }
  });
});
