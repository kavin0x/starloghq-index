import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

let tmpCounter = 0;

/**
 * Atomically write a file by writing to a temp sibling and renaming over the
 * target. `rename(2)` is atomic on the same filesystem, so a crash, power loss,
 * or ENOSPC mid-write can never leave the target truncated — readers see either
 * the old bytes or the new bytes, never a partial file.
 *
 * Note: this protects against *torn/truncated* writes only. It does NOT make
 * concurrent writers safe — two overlapping `atomicWrite` calls to the same path
 * still race to last-writer-wins. Use a lock if you need that.
 *
 * The temp file lives in the same directory as the target (required: `rename`
 * is only atomic within a single filesystem) and carries the pid plus a
 * per-process counter to avoid collisions between concurrent writes.
 */
export async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the orphaned temp file; surface the real error.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
