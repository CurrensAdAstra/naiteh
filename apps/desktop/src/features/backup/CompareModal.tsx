import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  backupCompare,
  backupReadFile,
  backupRestoreFile,
  type BackupFileContent,
  type CompareEntry,
  type CompareReport,
  type CompareRow,
  type CompareSource,
} from "../../lib/api/backup";
import { notesVersion } from "../../lib/api/notes";
import { diffLines, diffStats, type DiffLine } from "../../lib/lineDiff";
import { openDocument, targetForRelPath } from "../../lib/openDocument";
import { formatAppError, isAppError } from "../../lib/types";
import { useBackupStore } from "../../state/backupStore";
import {
  filterRows,
  formatSize,
  LOCAL_ID,
  type CompareFilter,
} from "./backupFormat";
import { useDialogFocus } from "../settings/useDialogFocus";
import settings from "../settings/SettingsModal.module.css";
import styles from "./Backup.module.css";

/**
 * "Compare copies": the local vault next to every backup target, file
 * by file. Rows come from `backup_compare`; a selected row shows a line
 * diff (Local vs a chosen backup) and can restore that backup's copy,
 * as a new file by default or over the local file after confirmation.
 */

const FILTERS: readonly { id: CompareFilter; label: string }[] = [
  { id: "all", label: "All differences" },
  { id: "missing", label: "Only missing" },
  { id: "changed", label: "Only changed" },
  { id: "identical", label: "Show identical" },
];

const shortHash = (h: string) => h.slice(0, 8);

/** The entry every other cell is compared with: Local, else the first present. */
function reference(row: CompareRow, sources: readonly CompareSource[]) {
  const local = row.entries[LOCAL_ID];
  if (local !== undefined && local !== null) return local;
  for (const s of sources) {
    const e = row.entries[s.id];
    if (e !== undefined && e !== null) return e;
  }
  return null;
}

function Cell({
  entry,
  refEntry,
  sourceOk,
}: {
  entry: CompareEntry | null | undefined;
  refEntry: CompareEntry | null;
  sourceOk: boolean;
}) {
  if (!sourceOk) return <span className={styles.cellMeta}>—</span>;
  if (entry === undefined || entry === null) {
    return <span className={`${styles.badge} ${styles.missing}`}>missing</span>;
  }
  if (refEntry !== null && entry.hash === refEntry.hash) {
    return (
      <span className={styles.same} title={`${formatSize(entry.size)} · ${entry.hash}`}>
        ✓ same
      </span>
    );
  }
  return (
    <span title={entry.hash}>
      <span className={`${styles.badge} ${styles.differs}`}>differs</span>
      <span className={styles.cellMeta}>
        {formatSize(entry.size)} · {shortHash(entry.hash)}
      </span>
    </span>
  );
}

function DiffView({ lines }: { lines: readonly DiffLine[] }) {
  return (
    <pre className={styles.diff} data-testid="compare-diff">
      {lines.map((l, i) => (
        <span
          key={i}
          className={`${styles.diffLine} ${
            l.kind === "add" ? styles.add : l.kind === "del" ? styles.del : ""
          }`}
          data-kind={l.kind}
        >
          <span className={styles.lineNo}>{l.oldLine ?? ""}</span>
          <span className={styles.lineNo}>{l.newLine ?? ""}</span>
          <span>{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
          <span>{l.text}</span>
        </span>
      ))}
    </pre>
  );
}

interface Loaded {
  local: BackupFileContent | null;
  other: BackupFileContent | null;
}

function Detail({
  row,
  sources,
  onRestored,
}: {
  row: CompareRow;
  sources: readonly CompareSource[];
  onRestored: (relPath: string) => void;
}) {
  const others = sources.filter((s) => s.id !== LOCAL_ID && s.ok);
  const firstWithFile =
    others.find((s) => (row.entries[s.id] ?? null) !== null) ?? others[0];
  const [otherId, setOtherId] = useState<string>(firstWithFile?.id ?? "");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);

  const hasLocal = (row.entries[LOCAL_ID] ?? null) !== null;
  const hasOther = otherId !== "" && (row.entries[otherId] ?? null) !== null;
  const otherName = sources.find((s) => s.id === otherId)?.name ?? otherId;

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setError(null);
    setConfirmOverwrite(false);
    const read = (id: string, present: boolean) =>
      present ? backupReadFile(id, row.relPath) : Promise.resolve(null);
    Promise.all([read(LOCAL_ID, hasLocal), read(otherId, hasOther)])
      .then(([local, other]) => {
        if (live) setLoaded({ local, other });
      })
      .catch((e: unknown) => {
        if (live) setError(formatAppError(e));
      });
    return () => {
      live = false;
    };
  }, [row.relPath, otherId, hasLocal, hasOther]);

  const binary =
    loaded !== null &&
    (loaded.local?.binary === true || loaded.other?.binary === true);
  const lines = useMemo(() => {
    if (loaded === null || binary) return null;
    return diffLines(loaded.local?.content ?? "", loaded.other?.content ?? "");
  }, [loaded, binary]);
  const stats = lines === null ? null : diffStats(lines);

  async function restore(mode: "copy" | "overwrite") {
    setBusy(true);
    setError(null);
    setRestoreMsg(null);
    try {
      const expectedVersion =
        mode === "overwrite" && hasLocal ? await notesVersion(row.relPath) : null;
      const res = await backupRestoreFile(otherId, row.relPath, mode, expectedVersion);
      setConfirmOverwrite(false);
      setRestoreMsg(`Restored as ${res.relPath}`);
      onRestored(res.relPath);
    } catch (e) {
      setError(
        isAppError(e) && e.kind === "StaleWrite"
          ? "The local file changed while you were comparing. Refresh and try again."
          : formatAppError(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.detail} data-testid="compare-detail">
      <div className={styles.detailBar}>
        <code className={styles.relPath}>{row.relPath}</code>
        <span>Local vs</span>
        <select
          className={styles.select}
          value={otherId}
          onChange={(e) => setOtherId(e.currentTarget.value)}
          aria-label="Compare local with"
          data-testid="compare-other"
        >
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {stats !== null && (
          <span className={styles.cellMeta}>
            <span className={styles.add}>+{stats.added}</span>{" "}
            <span className={styles.del}>-{stats.removed}</span>
          </span>
        )}
        <span className={styles.spacer} />
        <button
          type="button"
          className={settings.button}
          onClick={() => void restore("copy")}
          disabled={busy || !hasOther}
          data-testid="compare-restore-copy"
        >
          Restore to vault as copy
        </button>
        <button
          type="button"
          className={settings.button}
          onClick={() => setConfirmOverwrite(true)}
          disabled={busy || !hasOther}
          data-testid="compare-restore-overwrite"
        >
          Overwrite local…
        </button>
      </div>
      {confirmOverwrite && (
        <div className={styles.confirm} role="alertdialog" aria-label="Overwrite local file">
          <span>
            Replace the local <code>{row.relPath}</code> with the copy from{" "}
            {otherName}? The current local version is lost unless it is in a
            backup.
          </span>
          <button
            type="button"
            className={`${settings.button} ${settings.buttonPrimary}`}
            onClick={() => void restore("overwrite")}
            disabled={busy}
            data-testid="compare-overwrite-confirm"
          >
            Overwrite
          </button>
          <button
            type="button"
            className={settings.button}
            onClick={() => setConfirmOverwrite(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {error !== null && (
        <p className={settings.error} role="alert" data-testid="compare-error">
          {error}
        </p>
      )}
      {restoreMsg !== null && (
        <p className={styles.meta} role="status">
          {restoreMsg}
        </p>
      )}
      {loaded === null && error === null && <p className={styles.status}>Loading…</p>}
      {binary && loaded !== null && (
        <div className={styles.binary} data-testid="compare-binary">
          Binary file — no text diff.
          <br />
          Local:{" "}
          {loaded.local === null
            ? "missing"
            : `${formatSize(loaded.local.size)} · ${loaded.local.hash}`}
          <br />
          {otherName}:{" "}
          {loaded.other === null
            ? "missing"
            : `${formatSize(loaded.other.size)} · ${loaded.other.hash}`}
        </div>
      )}
      {lines !== null && <DiffView lines={lines} />}
    </div>
  );
}

export function CompareModal() {
  const setCompareOpen = useBackupStore((s) => s.setCompareOpen);
  const close = useCallback(() => setCompareOpen(false), [setCompareOpen]);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, close);

  const [deep, setDeep] = useState(false);
  const [filter, setFilter] = useState<CompareFilter>("all");
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<CompareReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const includeSame = filter === "identical";
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await backupCompare(deep, includeSame);
      if (ticket === requestRef.current) setReport(next);
    } catch (e) {
      if (ticket === requestRef.current) setError(formatAppError(e));
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, [deep, includeSame]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sources = report?.sources ?? [];
  const rows = useMemo(
    () => (report === null ? [] : filterRows(report.rows, filter, query)),
    [report, filter, query],
  );
  const selectedRow =
    selected === null
      ? null
      : (report?.rows.find((r) => r.relPath === selected) ?? null);

  async function restored(relPath: string) {
    await refresh();
    if (/\.md$/i.test(relPath)) {
      await openDocument(targetForRelPath(relPath)).catch(() => false);
    }
  }

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      data-testid="compare-modal"
    >
      <div
        ref={dialogRef}
        className={styles.compare}
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-title"
        tabIndex={-1}
      >
        <div className={styles.compareHeader}>
          <div className={styles.titleRow}>
            <h1 className={styles.title} id="compare-title">
              Compare copies
            </h1>
            <span className={styles.spacer} />
            <label className={styles.switchLabel}>
              <button
                type="button"
                role="switch"
                aria-checked={deep}
                aria-label="Deep check"
                className={`${settings.toggle} ${deep ? settings.toggleOn : ""}`}
                onClick={() => setDeep((d) => !d)}
                data-testid="compare-deep"
              />
              Deep check (re-hash backups, slower)
            </label>
            <button
              type="button"
              className={settings.button}
              onClick={() => void refresh()}
              disabled={loading}
              data-testid="compare-refresh"
            >
              <RefreshCw size={13} aria-hidden="true" /> Refresh
            </button>
            <button
              type="button"
              className={settings.button}
              onClick={close}
              aria-label="Close compare"
              data-testid="compare-close"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className={styles.sources} data-testid="compare-sources">
            {sources.map((s) => (
              <div
                key={s.id}
                className={`${styles.source} ${s.ok ? styles.sourceOk : styles.sourceErr}`}
                data-testid={`compare-source-${s.id}`}
              >
                <strong>{s.name}</strong>
                {s.ok ? (
                  <span className={styles.meta}>
                    {s.fileCount.toLocaleString()} files
                  </span>
                ) : (
                  <span className={styles.errorText}>{s.error ?? "Unavailable"}</span>
                )}
              </div>
            ))}
          </div>
          <div className={styles.toolbar}>
            <div role="radiogroup" aria-label="Show" className={styles.toolbar}>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={filter === f.id}
                  className={`${styles.chip} ${filter === f.id ? styles.chipOn : ""}`}
                  onClick={() => setFilter(f.id)}
                  data-testid={`compare-filter-${f.id}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <input
              className={styles.search}
              type="search"
              placeholder="Filter by path"
              aria-label="Filter by path"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              data-testid="compare-search"
            />
            <span className={styles.meta}>
              {report !== null && `${rows.length} of ${report.rows.length} files`}
            </span>
          </div>
        </div>

        <div className={`${styles.body} ${selectedRow === null ? styles.bodySingle : ""}`}>
          <div className={styles.tableWrap}>
            {error !== null && (
              <p className={settings.error} role="alert">
                {error}
              </p>
            )}
            {loading && report === null && (
              <p className={styles.status}>Comparing…</p>
            )}
            {report !== null && rows.length === 0 && (
              <p className={styles.status} data-testid="compare-empty">
                {filter === "all" && query === ""
                  ? "All copies match."
                  : "No files match this filter."}
              </p>
            )}
            {rows.length > 0 && (
              <table className={styles.table} data-testid="compare-table">
                <thead>
                  <tr>
                    <th scope="col">Path</th>
                    {sources.map((s) => (
                      <th key={s.id} scope="col">
                        {s.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const ref = reference(r, sources);
                    return (
                      <tr
                        key={r.relPath}
                        className={`${styles.row} ${
                          selected === r.relPath ? styles.rowSelected : ""
                        }`}
                        aria-selected={selected === r.relPath}
                        tabIndex={0}
                        onClick={() => setSelected(r.relPath)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") setSelected(r.relPath);
                        }}
                        data-testid={`compare-row-${r.relPath}`}
                        data-status={r.status}
                      >
                        <td className={styles.relPath}>{r.relPath}</td>
                        {sources.map((s) => (
                          <td key={s.id} data-testid={`compare-cell-${r.relPath}-${s.id}`}>
                            <Cell entry={r.entries[s.id]} refEntry={ref} sourceOk={s.ok} />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {selectedRow !== null && (
            <Detail
              key={selectedRow.relPath}
              row={selectedRow}
              sources={sources}
              onRestored={(p) => void restored(p)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
