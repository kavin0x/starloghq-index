import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upsertMarkedSection, removeMarkedSection } from './init.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'starlog-init-test-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const exists = (p: string) =>
  access(p).then(() => true, () => false);

describe('upsertMarkedSection() + removeMarkedSection()', () => {
  it('round-trips a file with pre-existing content byte-for-byte', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    const original = '# My Project\n\nSome existing instructions.\n';
    await writeFile(target, original);

    const up = await upsertMarkedSection(target);
    expect(up.changed).toBe(true);
    expect(await readFile(target, 'utf8')).toContain('starlog:init');

    const down = await removeMarkedSection(target);
    expect(down.changed).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(original); // byte-identical
  });

  it('preserves content the user appended AFTER the Starlog section (the M2 bug)', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await writeFile(target, '# Title\n');
    await upsertMarkedSection(target);

    // User edits the file and adds their own prose below the Starlog block.
    const withUserTail = (await readFile(target, 'utf8')) + '\n# My own notes\nKeep me.\n';
    await writeFile(target, withUserTail);

    const down = await removeMarkedSection(target);
    expect(down.changed).toBe(true);

    const result = await readFile(target, 'utf8');
    expect(result).toContain('# Title');
    expect(result).toContain('# My own notes');
    expect(result).toContain('Keep me.');
    expect(result).not.toContain('starlog:init');
    expect(result).not.toContain('starlog:end');
  });

  it('writes a .bak with the pre-removal content before deleting', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await writeFile(target, '# Title\n');
    await upsertMarkedSection(target);
    const beforeRemoval = await readFile(target, 'utf8');

    const down = await removeMarkedSection(target);
    expect(down.backedUp).toBe(true);
    expect(await exists(`${target}.bak`)).toBe(true);
    expect(await readFile(`${target}.bak`, 'utf8')).toBe(beforeRemoval);
  });

  it('handles a marker at the start of an otherwise-empty file', async () => {
    const target = join(tmpRoot, 'AGENTS.md');
    const up = await upsertMarkedSection(target); // file did not exist
    expect(up.changed).toBe(true);

    const down = await removeMarkedSection(target);
    expect(down.changed).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('');
  });

  it('is idempotent: a second upsert is a no-op', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await upsertMarkedSection(target);
    const afterFirst = await readFile(target, 'utf8');

    const second = await upsertMarkedSection(target);
    expect(second.changed).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(afterFirst);
  });

  it('removes a legacy section (start marker, no end marker) without throwing', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    // Simulate a pre-end-marker install: start marker, no end marker, trailing comment.
    const legacy =
      '# Title\n\n<!-- starlog:init -->\n## Starlog — Capability Search\n\nold instructions\n<!-- other-tool -->\nkeep this\n';
    await writeFile(target, legacy);

    const down = await removeMarkedSection(target);
    expect(down.changed).toBe(true);
    const result = await readFile(target, 'utf8');
    expect(result).not.toContain('starlog:init');
    expect(result).toContain('# Title');
    expect(result).toContain('keep this');
  });

  it('refreshes drifted instruction text in place (L7), preserving surrounding content', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await writeFile(target, '# Title\n');
    await upsertMarkedSection(target);
    // Simulate drift: user appends content, and the section body gets stale.
    const installed = await readFile(target, 'utf8');
    const staleBody = installed.replace(
      'ALWAYS consult',
      'OUTDATED please ignore — ALWAYS consult',
    );
    await writeFile(target, staleBody + '\n# User notes\nKeep me.\n');

    const up = await upsertMarkedSection(target);
    expect(up.changed).toBe(true);

    const result = await readFile(target, 'utf8');
    expect(result).not.toContain('OUTDATED please ignore'); // stale body replaced
    expect(result).toContain('ALWAYS consult');             // current body present
    expect(result).toContain('# Title');                    // content before preserved
    expect(result).toContain('Keep me.');                   // content after preserved
    // Exactly one section remains (no duplication).
    expect(result.split('starlog:init').length - 1).toBe(1);
    expect(result.split('starlog:end').length - 1).toBe(1);

    // And it's now idempotent again.
    const again = await upsertMarkedSection(target);
    expect(again.changed).toBe(false);
  });

  it('does NOT touch a legacy section without an end marker (avoids clobbering)', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    const legacy =
      '# Title\n\n<!-- starlog:init -->\n## Starlog — Capability Search\n\nold body\n# User notes\nKeep me.\n';
    await writeFile(target, legacy);

    const up = await upsertMarkedSection(target);
    expect(up.changed).toBe(false);          // refused to refresh unbounded section
    expect(await readFile(target, 'utf8')).toBe(legacy); // untouched
  });

  it('is a no-op on a file with no Starlog marker', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await writeFile(target, '# Just my stuff\n');
    const down = await removeMarkedSection(target);
    expect(down.changed).toBe(false);
    expect(down.backedUp).toBe(false);
    expect(await exists(`${target}.bak`)).toBe(false);
  });
});
