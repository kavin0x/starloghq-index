import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite } from './fsutil.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'starlog-fsutil-test-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('atomicWrite()', () => {
  it('writes content to a new file', async () => {
    const target = join(tmpRoot, 'new.json');
    await atomicWrite(target, '{"a":1}\n');
    expect(await readFile(target, 'utf8')).toBe('{"a":1}\n');
  });

  it('overwrites an existing file', async () => {
    const target = join(tmpRoot, 'existing.json');
    await writeFile(target, 'old');
    await atomicWrite(target, 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('creates missing parent directories', async () => {
    const target = join(tmpRoot, 'a', 'b', 'c', 'deep.json');
    await atomicWrite(target, 'deep');
    expect(await readFile(target, 'utf8')).toBe('deep');
  });

  it('leaves no temp files behind on success', async () => {
    const target = join(tmpRoot, 'clean.json');
    await atomicWrite(target, 'x');
    const entries = await readdir(tmpRoot);
    expect(entries).toEqual(['clean.json']);
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false);
  });

  it('handles concurrent writes to distinct paths without temp-name collision', async () => {
    const targets = Array.from({ length: 10 }, (_, i) => join(tmpRoot, `c${i}.json`));
    await Promise.all(targets.map((t, i) => atomicWrite(t, String(i))));
    for (let i = 0; i < targets.length; i++) {
      expect(await readFile(targets[i], 'utf8')).toBe(String(i));
    }
    const leftovers = (await readdir(tmpRoot)).filter((e) => e.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
