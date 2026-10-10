import { journalSave } from "../lib/api/journal";
import { notesWrite } from "../lib/api/notes";
import { formatAppError } from "../lib/types";
import {
  isDirty,
  keyFor,
  useEditorStore,
  type OpenSource,
} from "./editorStore";
import { useVaultStore } from "./vaultStore";

/**
 * Debounced, serialised persistence for the editor.
 *
 * Every save captures *where* it goes (source + vault) at the moment the
 * edit happened, so a timer that fires after the user switched notes
 * still writes to the original file. Writes run one at a time; after a
 * write lands only the text that was actually written is marked saved
 * (`markSaved(key, content)`), so keystrokes typed during an in-flight
 * write stay dirty and are saved by the next round.
 *
 * Anything that is about to move the editor off the current document —
 * opening another note, closing, rename/delete, sync, logout, window
 * close — awaits {@link flushPendingSave} first.
 */

export const AUTOSAVE_DELAY_MS = 800;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

interface PendingSave {
  key: string;
  source: OpenSource;
  content: string;
  /** Vault the edit belongs to; the write is dropped if it changed. */
  vaultRoot: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export type SaveListener = (source: OpenSource, content: string) => void;

const pending = new Map<string, PendingSave>();
const retryDelay = new Map<string, number>();
const listeners = new Set<SaveListener>();
let chain: Promise<void> = Promise.resolve();
let suspendCount = 0;

function currentVaultRoot(): string | null {
  return useVaultStore.getState().active?.root ?? null;
}

async function persist(source: OpenSource, content: string): Promise<void> {
  if (source.kind === "note") {
    await notesWrite(source.relPath, content);
  } else {
    await journalSave(source.date, content);
  }
}

function clearTimer(entry: PendingSave): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function arm(entry: PendingSave, delay: number): void {
  clearTimer(entry);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    // While suspended (rename/delete in progress) the entry is held, not
    // written; resumeAutosave() re-arms it.
    if (suspendCount > 0) return;
    if (pending.get(entry.key) !== entry) return;
    pending.delete(entry.key);
    void enqueueWrite(entry);
  }, delay);
}

function enqueueWrite(entry: PendingSave): Promise<void> {
  const run = chain.then(() => write(entry));
  chain = run;
  return run;
}

async function write(entry: PendingSave): Promise<void> {
  if (entry.vaultRoot !== currentVaultRoot()) return;
  const store = useEditorStore.getState();
  try {
    await persist(entry.source, entry.content);
  } catch (e) {
    const message = formatAppError(e);
    console.error("autosave failed:", message);
    useEditorStore.getState().setSaveError(entry.key, message);
    // Retry with backoff unless a newer edit already queued its own save.
    if (!pending.has(entry.key)) {
      const delay = retryDelay.get(entry.key) ?? RETRY_BASE_MS;
      retryDelay.set(entry.key, Math.min(delay * 2, RETRY_MAX_MS));
      const retry: PendingSave = { ...entry, timer: null };
      pending.set(entry.key, retry);
      arm(retry, delay);
    }
    return;
  }
  retryDelay.delete(entry.key);
  store.markSaved(entry.key, entry.content);
  useEditorStore.getState().setSaveError(entry.key, null);
  for (const listener of listeners) {
    try {
      listener(entry.source, entry.content);
    } catch {
      // Listener failures (audit logging) never affect persistence.
    }
  }
}

/**
 * Queue a debounced save of `content` to `source`. Re-scheduling the same
 * document resets its timer; other documents keep their own pending save.
 */
export function scheduleSave(
  source: OpenSource,
  content: string,
  delay: number = AUTOSAVE_DELAY_MS,
): void {
  const key = keyFor(source);
  const existing = pending.get(key);
  if (existing !== undefined) clearTimer(existing);
  const entry: PendingSave = {
    key,
    source,
    content,
    vaultRoot: currentVaultRoot(),
    timer: null,
  };
  pending.set(key, entry);
  arm(entry, delay);
}

/**
 * Write every pending save immediately (plus the open document if it is
 * dirty but not yet scheduled) and wait for all writes — including ones
 * already in flight — to settle. Never rejects: failures are recorded in
 * `editorStore.saveError` and retried.
 */
export async function flushPendingSave(): Promise<void> {
  const open = useEditorStore.getState().open;
  if (open !== null && isDirty(open)) {
    const existing = pending.get(open.key);
    if (existing === undefined || existing.content !== open.content) {
      if (existing !== undefined) clearTimer(existing);
      pending.set(open.key, {
        key: open.key,
        source: open.source,
        content: open.content,
        vaultRoot: currentVaultRoot(),
        timer: null,
      });
    }
  }
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) {
    clearTimer(entry);
    void enqueueWrite(entry);
  }
  await chain;
}

/**
 * Drop pending (not yet started) saves — all of them, or only the one for
 * `key`. Used when the target file is going away (delete, rename) or the
 * vault switched underneath it.
 */
export function discardPendingSave(key?: string): void {
  for (const entry of [...pending.values()]) {
    if (key !== undefined && entry.key !== key) continue;
    clearTimer(entry);
    pending.delete(entry.key);
    retryDelay.delete(entry.key);
  }
}

/** True when a save is queued (or the open document is dirty). */
export function hasPendingSave(): boolean {
  const open = useEditorStore.getState().open;
  return pending.size > 0 || (open !== null && isDirty(open));
}

/**
 * Hold timer-driven writes until the returned `resume` is called (explicit
 * flushes still run). Bracket file-moving operations with this so a timer
 * can't write to a path that is being renamed or deleted.
 */
export function suspendAutosave(): () => void {
  suspendCount += 1;
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    suspendCount -= 1;
    if (suspendCount > 0) return;
    for (const entry of pending.values()) {
      if (entry.timer === null) arm(entry, AUTOSAVE_DELAY_MS);
    }
  };
}

/** Notified after every successful write (used for audit logging). */
export function onSaved(listener: SaveListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: forget all pending work and listeners. */
export function resetAutosaveForTests(): void {
  for (const entry of pending.values()) clearTimer(entry);
  pending.clear();
  retryDelay.clear();
  listeners.clear();
  suspendCount = 0;
  chain = Promise.resolve();
}
