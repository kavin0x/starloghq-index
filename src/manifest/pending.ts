import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

/**
 * A package detected by the PostToolUse hook that needs manifest generation.
 * Stored in both project-local (.starlog/pending.json) and global (~/.starlog/pending.json) queues.
 */
export interface PendingEntry {
  package_name: string;       // Original name (e.g., "@clerk/nextjs", "django-rest-framework")
  manifest_id: string;        // Normalized for dedup (e.g., "nextjs", "django-rest-framework")
  ecosystem: 'npm' | 'pypi';  // Detected from install command
  detected_at: string;        // ISO timestamp
  source_project: string;     // Absolute path of project where detected
  install_command: string;    // Full command that triggered detection
  status: 'pending' | 'generated' | 'failed' | 'unresolvable';
  error?: string;             // Error message if failed
  generated_at?: string;      // ISO timestamp when manifest was generated
}

/** Returns the path to the global pending queue (~/.starlog/pending.json). */
export function getGlobalQueuePath(): string {
  return join(homedir(), '.starlog', 'pending.json');
}

/** Returns the path to the project-local pending queue ({projectDir}/.starlog/pending.json). */
export function getLocalQueuePath(projectDir: string): string {
  return join(projectDir, '.starlog', 'pending.json');
}

/**
 * Read and parse a pending queue file. Returns [] if file doesn't exist.
 * Rethrows non-ENOENT errors.
 */
export async function readQueue(queuePath: string): Promise<PendingEntry[]> {
  try {
    const data = await readFile(queuePath, 'utf-8');
    return JSON.parse(data) as PendingEntry[];
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * Write a pending queue to disk, creating parent directories as needed.
 */
export async function writeQueue(queuePath: string, entries: PendingEntry[]): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

/**
 * Append an entry to a pending queue, deduplicating by manifest_id (D-11).
 * If an entry with the same manifest_id already exists, skips silently.
 */
export async function appendToQueue(queuePath: string, entry: PendingEntry): Promise<boolean> {
  const queue = await readQueue(queuePath);
  if (queue.some(e => e.manifest_id === entry.manifest_id)) {
    return false; // Already exists -- dedup
  }
  queue.push(entry);
  await writeQueue(queuePath, queue);
  return true;
}

/**
 * Append an entry to both global and local pending queues (D-03).
 * Returns { queued: true } if the entry was new to the global queue, { queued: false } if already present.
 */
export async function appendToBothQueues(
  entry: PendingEntry,
  projectDir: string,
): Promise<{ queued: boolean }> {
  const [globalResult] = await Promise.all([
    appendToQueue(getGlobalQueuePath(), entry),
    appendToQueue(getLocalQueuePath(projectDir), entry),
  ]);
  return { queued: globalResult };
}

/**
 * Get only entries with status === 'pending' from a queue.
 */
export async function getPendingEntries(queuePath: string): Promise<PendingEntry[]> {
  const queue = await readQueue(queuePath);
  return queue.filter(e => e.status === 'pending');
}

/**
 * Update the status (and optional extra fields) of a specific entry by manifest_id.
 * No-op if the entry is not found.
 */
export async function updateEntryStatus(
  queuePath: string,
  manifestId: string,
  status: PendingEntry['status'],
  extra?: { error?: string; generated_at?: string },
): Promise<void> {
  const queue = await readQueue(queuePath);
  const entry = queue.find(e => e.manifest_id === manifestId);
  if (!entry) return;

  entry.status = status;
  if (extra?.error !== undefined) entry.error = extra.error;
  if (extra?.generated_at !== undefined) entry.generated_at = extra.generated_at;

  await writeQueue(queuePath, queue);
}
