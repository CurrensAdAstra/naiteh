import { journalSave } from "../lib/api/journal";
import { notesWrite } from "../lib/api/notes";
import { localCopyRelPath } from "../lib/localCopy";
import { formatAppError, isStaleWrite } from "../lib/types";
import {
  isDirty,
  keyFor,
  useEditorStore,
  type OpenSource,
} from "./editorStore";
import { useUIStore } from "./uiStore";
import { notifyVaultContentChanged } from "./vaultContentStore";
import { useVaultStore } from "./vaultStore";

/**
 * Debounced, serialised persistence for the editor.
 *
 * Every save captures *where* it goes (source + vault) at the moment the
 * edit happened, so a timer that fires after the user switched notes
 * still writes to the original file. Writes run one at a time; after a
 * write lands only the text that was actually written is marked saved
 * (`markSaved(key, content, version)`), so keystrokes typed during an
 * in-flight write stay dirty and are saved by the next round.
 *
 * Optimistic concurrency: every write sends the version token of the
 * text the editor last saw on disk (`open.savedVersion`). When the file
 * changed outside naiteh meanwhile (Google Drive sync, another editor)
 * the backend refuses with `StaleWrite` and the document enters the
 * conflict state (`editorStore.externalChange`); autosave is then *held*
 * for that key until the user resolves it (lib/externalChange). Held
 * edits are never dropped: moving off the document (open another note,
 * close, logout, window close — `flushPendingSave({ leaving: true })`)
 * writes them to a `.local-<timestamp>.md` copy next to the original.
 * If that copy can't be written the entry stays pending (still held) and
 * the copy is retried with the same backoff as ordinary save failures;
 * the hold is released only once the copy has landed. Flushes report
 * the outcome ({@link FlushResult}) so callers can refuse to leave
 * (window close, logout) rather than lose the text.
 *
 * Anything that is about to move the editor off the current document
 * awaits {@link flushPendingSave} first.
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
  /**
   * Version the editor believed was on disk when the edit was scheduled.
   * Refreshed from the store at write time while the document is still
   * open (an earlier write in the chain may have advanced it).
   */
  expectedVersion: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Held entry whose `.local-` copy failed; its timer retries the copy. */
  copyRetry?: boolean;
}

export type SaveListener = (source: OpenSource, content: string) => void;

const pending = new Map<string, PendingSave>();
const retryDelay = new Map<string, number>();
const listeners = new Set<SaveListener>();
/** Keys whose writes are held because the file changed on disk. */
const held = new Set<string>();
/** Keys with a write currently awaiting the backend. */
const inFlight = new Set<string>();
let chain: Promise<void> = Promise.resolve();
let suspendCount = 0;

function currentVaultRoot(): string | null {
  return useVaultStore.getState().active?.root ?? null;
}

function isOpenKey(key: string): boolean {
  return useEditorStore.getState().open?.key === key;
}

/** `""` (file not on disk yet) means "no expectation": write unconditionally. */
function asExpected(version: string | null): string | null {
  return version === null || version === "" ? null : version;
}

function expectedVersionFor(entry: PendingSave): string | null {
  const open = useEditorStore.getState().open;
  if (open !== null && open.key === entry.key) {
    return asExpected(open.savedVersion);
  }
  return asExpected(entry.expectedVersion);
}

/** Resolves with the version token of the bytes written. */
async function persist(
  source: OpenSource,
  content: string,
  expectedVersion: string | null,
): Promise<string> {
  if (source.kind === "note") {
    const result = await notesWrite(source.relPath, content, expectedVersion);
    return result.version;
  }
  const result = await journalSave(source.date, content, expectedVersion);
  return result.version;
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
    // While suspended (rename/delete in progress) or held (conflict with
    // the file on disk) the entry stays pending, not written;
    // resumeAutosave() / releaseSave() decide what happens to it.
    if (suspendCount > 0) return;
    if (pending.get(entry.key) !== entry) return;
    if (held.has(entry.key)) {
      // Only a failed `.local-` copy is retried by timer; ordinary held
      // edits wait for the conflict resolution.
      if (entry.copyRetry !== true) return;
      pending.delete(entry.key);
      void enqueue(async () => {
        await preserveAsCopy(entry);
      });
      return;
    }
    pending.delete(entry.key);
    void enqueueWrite(entry);
  }, delay);
}

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = chain.then(task);
  // A rejected task (saveNow) must not poison the queue for later writes.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function notifyListeners(source: OpenSource, content: string): void {
  for (const listener of listeners) {
    try {
      listener(source, content);
    } catch {
      // Listener failures (audit logging) never affect persistence.
    }
  }
}

/**
 * Write `content` to `source` right away — serialised with the autosave
 * queue but bypassing a hold — then mark it saved and notify listeners.
 * Resolves with the new version token; rejects with the backend error
 * (including `StaleWrite`). Used by conflict resolution ("Keep mine").
 */
export function saveNow(
  source: OpenSource,
  content: string,
  expectedVersion: string | null,
): Promise<string> {
  const key = keyFor(source);
  let version = "";
  return enqueue(async () => {
    inFlight.add(key);
    try {
      version = await persist(source, content, expectedVersion);
    } finally {
      inFlight.delete(key);
    }
    retryDelay.delete(key);
    useEditorStore.getState().markSaved(key, content, version);
    useEditorStore.getState().setSaveError(key, null);
    notifyListeners(source, content);
  }).then(() => version);
}

function enqueueWrite(entry: PendingSave): Promise<boolean> {
  let ok = false;
  return enqueue(async () => {
    ok = await write(entry);
  }).then(() => ok);
}

/** Re-queue `entry` with a backoff retry (2 s doubling to 60 s per key). */
function scheduleRetry(entry: PendingSave): void {
  const delay = retryDelay.get(entry.key) ?? RETRY_BASE_MS;
  retryDelay.set(entry.key, Math.min(delay * 2, RETRY_MAX_MS));
  const retry: PendingSave = { ...entry, timer: null };
  pending.set(entry.key, retry);
  arm(retry, delay);
}

/** Put `entry` back in the queue without a timer (held until released). */
function park(entry: PendingSave): void {
  if (!pending.has(entry.key)) pending.set(entry.key, { ...entry, timer: null });
}

/** Resolves `false` when the text did not reach disk (retry scheduled). */
async function write(entry: PendingSave): Promise<boolean> {
  if (entry.vaultRoot !== currentVaultRoot()) return true;
  if (held.has(entry.key)) {
    // The document is in conflict. While it is open the edits stay in the
    // editor (and parked here) for the user to resolve; once it is gone
    // from the editor the only safe place for them is a copy.
    if (isOpenKey(entry.key)) {
      park(entry);
      return true;
    }
    return preserveAsCopy(entry);
  }
  const expected = expectedVersionFor(entry);
  let version: string;
  inFlight.add(entry.key);
  try {
    version = await persist(entry.source, entry.content, expected);
  } catch (e) {
    if (isStaleWrite(e)) {
      return onStaleWrite(entry, e.message);
    }
    const message = formatAppError(e);
    console.error("autosave failed:", message);
    // Retry with backoff unless a newer edit already queued its own save
    // (either way another write of this key is coming).
    if (!pending.has(entry.key)) scheduleRetry(entry);
    useEditorStore.getState().setSaveError(entry.key, message, true);
    return false;
  } finally {
    inFlight.delete(entry.key);
  }
  retryDelay.delete(entry.key);
  useEditorStore.getState().markSaved(entry.key, entry.content, version);
  useEditorStore.getState().setSaveError(entry.key, null);
  notifyListeners(entry.source, entry.content);
  return true;
}

/**
 * The backend refused the write: the file on disk is no longer the
 * version the editor saw (`diskVersion`; `""` = gone). Never retry
 * blindly — the user decides (lib/externalChange). If the document is no
 * longer open there is nobody to ask, so the edits go to a copy.
 */
async function onStaleWrite(
  entry: PendingSave,
  diskVersion: string,
): Promise<boolean> {
  if (!isOpenKey(entry.key)) {
    // Hold first: a failed copy must stay held (retried as a copy, never
    // written blindly over the changed file).
    held.add(entry.key);
    return preserveAsCopy(entry);
  }
  holdSave(entry.key);
  park(entry);
  const editor = useEditorStore.getState();
  editor.setSaveError(entry.key, null);
  editor.setExternalChange({ key: entry.key, diskVersion });
  return true;
}

function sourceRelPath(source: OpenSource): string {
  return source.relPath;
}

/**
 * Write `entry.content` to a `.local-<timestamp>.md` sibling of its file
 * (unconditionally — the copy is new) and release the hold. Lists are
 * told to refetch and the status bar says where the edits went.
 *
 * On failure the entry goes back into `pending` (still held, flagged
 * `copyRetry`) with a backoff retry — unless a newer edit of the key is
 * already pending, which carries the newer text and is retried instead.
 * Resolves `true` only when the copy landed; the text is never dropped.
 */
async function preserveAsCopy(entry: PendingSave): Promise<boolean> {
  if (entry.vaultRoot !== currentVaultRoot()) return true;
  const copyRelPath = localCopyRelPath(sourceRelPath(entry.source));
  try {
    await notesWrite(copyRelPath, entry.content, null);
  } catch (e) {
    const message = formatAppError(e);
    console.error("autosave: couldn't keep a copy of local edits:", message);
    held.add(entry.key);
    const newer = pending.get(entry.key);
    if (newer === undefined) {
      scheduleRetry({ ...entry, copyRetry: true });
    } else if (newer.copyRetry !== true) {
      clearTimer(newer);
      scheduleRetry({ ...newer, copyRetry: true });
    }
    useEditorStore.getState().setSaveError(entry.key, message, true);
    return false;
  }
  retryDelay.delete(entry.key);
  useEditorStore.getState().setSaveError(entry.key, null);
  releaseSave(entry.key);
  const editor = useEditorStore.getState();
  if (editor.externalChange?.key === entry.key) editor.setExternalChange(null);
  notifyVaultContentChanged();
  useUIStore.getState().setNotice(`Unsaved edits kept as ${copyRelPath}`);
  return true;
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
  const open = useEditorStore.getState().open;
  const entry: PendingSave = {
    key,
    source,
    content,
    vaultRoot: currentVaultRoot(),
    expectedVersion:
      open !== null && open.key === key
        ? open.savedVersion
        : (existing?.expectedVersion ?? null),
    timer: null,
  };
  pending.set(key, entry);
  arm(entry, delay);
}

export interface FlushOptions {
  /**
   * The caller is about to move the editor off the open document (open
   * another, close, logout, window close). Edits that are *held* because
   * the file changed on disk can't be written to their own path, so they
   * are preserved as a `.local-<timestamp>.md` copy instead of being
   * abandoned. Without this flag (Cmd+S) held edits simply stay pending.
   */
  leaving?: boolean;
}

/** What a {@link flushPendingSave} actually achieved. */
export interface FlushResult {
  /**
   * Keys whose text this flush did not get onto disk — neither to their
   * own file nor (leaving) to a `.local-` copy. Each is still pending
   * with a backoff retry and has `editorStore.saveError` set.
   */
  failedKeys: string[];
  /** False when a held edit could not be preserved as a `.local-` copy. */
  preserved: boolean;
}

/**
 * Write every pending save immediately (plus the open document if it is
 * dirty but not yet scheduled) and wait for all writes — including ones
 * already in flight — to settle. Never rejects: failures are recorded in
 * `editorStore.saveError`, retried with backoff, and reported in the
 * result. Held keys (conflict with the file on disk) are not written; see
 * {@link FlushOptions.leaving}. Resolves once every write it started has
 * settled once — it never waits for a backoff retry, so it can't hang on
 * a persistent failure.
 */
export async function flushPendingSave(
  opts: FlushOptions = {},
): Promise<FlushResult> {
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
        expectedVersion: open.savedVersion,
        timer: null,
      });
    }
  }
  const entries = [...pending.values()];
  pending.clear();
  const failedKeys: string[] = [];
  let preserved = true;
  const outcomes: Promise<void>[] = [];
  for (const entry of entries) {
    clearTimer(entry);
    if (held.has(entry.key)) {
      if (opts.leaving === true) {
        outcomes.push(
          enqueue(async () => {
            if (!(await preserveAsCopy(entry))) {
              failedKeys.push(entry.key);
              preserved = false;
            }
          }),
        );
      } else {
        pending.set(entry.key, entry);
      }
      continue;
    }
    outcomes.push(
      enqueueWrite(entry).then((ok) => {
        if (!ok) failedKeys.push(entry.key);
      }),
    );
  }
  await Promise.all(outcomes);
  await chain;
  if (opts.leaving === true) {
    // A write above may have hit `StaleWrite` while its document was still
    // open and been parked as held; the caller is leaving it, so it has
    // to go to a copy now too.
    const parked = [...pending.values()].filter(
      (e) => held.has(e.key) && e.copyRetry !== true && e.timer === null,
    );
    for (const entry of parked) {
      pending.delete(entry.key);
      await enqueue(async () => {
        if (!(await preserveAsCopy(entry))) {
          failedKeys.push(entry.key);
          preserved = false;
        }
      });
    }
  }
  return { failedKeys, preserved };
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
    // No retry is coming any more: the status bar must stop saying so.
    const err = useEditorStore.getState().saveError;
    if (err?.key === entry.key && err.retrying) {
      useEditorStore.getState().setSaveError(err.key, err.message, false);
    }
  }
  // Forgetting a key forgets its hold too (the file is gone or the vault
  // switched); a later re-open starts clean.
  if (key === undefined) held.clear();
  else held.delete(key);
}

/** True when a save is queued (or the open document is dirty). */
export function hasPendingSave(): boolean {
  const open = useEditorStore.getState().open;
  return pending.size > 0 || (open !== null && isDirty(open));
}

/**
 * Stop writing `key` to its own file until {@link releaseSave}: the file
 * changed on disk and the user has to choose (editorStore.externalChange).
 * Pending edits stay queued; explicit flushes skip the key too.
 */
export function holdSave(key: string): void {
  held.add(key);
  const entry = pending.get(key);
  if (entry !== undefined) clearTimer(entry);
}

/**
 * Lift the hold after the conflict was resolved. Whatever was queued for
 * the key is dropped: the resolution either wrote the editor's text
 * itself or replaced it with the disk version, and the editor's own
 * autosave effect re-schedules anything still dirty.
 */
export function releaseSave(key: string): void {
  held.delete(key);
  discardPendingSave(key);
}

/** True while autosave is held for `key` (see {@link holdSave}). */
export function isSaveHeld(key: string): boolean {
  return held.has(key);
}

/**
 * True while a write for `key` is awaiting the backend. External-change
 * checks skip such keys: the write itself reports a conflict precisely
 * (`StaleWrite`), whereas a version read mid-write would race it.
 */
export function hasSaveInFlight(key: string): boolean {
  return inFlight.has(key);
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
      if (entry.timer === null && !held.has(entry.key)) {
        arm(entry, AUTOSAVE_DELAY_MS);
      }
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
  held.clear();
  inFlight.clear();
  suspendCount = 0;
  chain = Promise.resolve();
}
