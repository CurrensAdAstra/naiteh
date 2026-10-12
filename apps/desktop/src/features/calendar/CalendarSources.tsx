import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import {
  calendarAdd,
  calendarRemove,
  calendarUpdate,
} from "../../lib/api/calendar";
import {
  CALENDAR_COLORS,
  formatAppError,
  type CalendarColor,
  type CalendarSource,
} from "../../lib/types";
import { calendarColorVar, isValidFeedUrl, kindForUrl } from "./eventUtils";
import styles from "./CalendarSources.module.css";

interface CalendarSourcesProps {
  calendars: CalendarSource[];
  refreshing: boolean;
  /** Re-list calendars and events after a change. */
  onChanged: () => void;
  onRefresh: () => void;
}

/** "My calendars": subscribed ICS feeds, pinned to the panel bottom. */
export function CalendarSources({
  calendars,
  refreshing,
  onChanged,
  onRefresh,
}: CalendarSourcesProps) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (op: () => Promise<unknown>) => {
    try {
      await op();
      setError(null);
      onChanged();
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  return (
    <section
      className={styles.section}
      aria-label="My calendars"
      data-testid="calendar-sources"
    >
      <div className={styles.header}>
        <button
          type="button"
          className={styles.collapse}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-testid="calendar-sources-toggle"
        >
          {open ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span className={styles.headerLabel}>My calendars</span>
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Refresh calendars"
          title="Refresh calendars"
          disabled={refreshing}
          onClick={onRefresh}
          data-testid="calendar-refresh"
        >
          <RefreshCw
            size={13}
            aria-hidden="true"
            className={refreshing ? styles.spin : undefined}
          />
        </button>
      </div>
      {open && (
        <div className={styles.body}>
          {error !== null && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {calendars.length === 0 && !adding && (
            <p className={styles.muted}>
              Subscribe to a Google or iCloud calendar to see its events here.
            </p>
          )}
          <ul className={styles.list}>
            {calendars.map((cal) => (
              <SourceRow
                key={cal.id}
                cal={cal}
                onUpdate={(patch) =>
                  void run(() => calendarUpdate({ id: cal.id, ...patch }))
                }
                onRemove={() => void run(() => calendarRemove(cal.id))}
              />
            ))}
          </ul>
          {adding ? (
            <AddCalendarDialog
              onCancel={() => setAdding(false)}
              onAdded={() => {
                setAdding(false);
                setError(null);
                onChanged();
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.addButton}
              onClick={() => setAdding(true)}
              data-testid="calendar-add-open"
            >
              <Plus size={13} aria-hidden="true" />
              Add calendar
            </button>
          )}
        </div>
      )}
    </section>
  );
}

type RowMode = "idle" | "menu" | "rename" | "color" | "remove";

interface SourceRowProps {
  cal: CalendarSource;
  onUpdate: (patch: {
    name?: string;
    color?: CalendarColor;
    enabled?: boolean;
  }) => void;
  onRemove: () => void;
}

function SourceRow({ cal, onUpdate, onRemove }: SourceRowProps) {
  const [mode, setMode] = useState<RowMode>("idle");
  const [name, setName] = useState(cal.name);
  const checkboxId = `calendar-enabled-${cal.id}`;

  const submitRename = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed !== "" && trimmed !== cal.name) onUpdate({ name: trimmed });
    setMode("idle");
  };

  return (
    <li className={styles.item} data-testid={`calendar-source-${cal.id}`}>
      <div className={styles.row}>
        <input
          id={checkboxId}
          type="checkbox"
          className={styles.checkbox}
          style={{ accentColor: calendarColorVar(cal.color) }}
          checked={cal.enabled}
          onChange={(e) => onUpdate({ enabled: e.target.checked })}
          data-testid={`calendar-source-enabled-${cal.id}`}
        />
        <label
          htmlFor={checkboxId}
          className={styles.name}
          title={`${cal.name} (${cal.urlHost})`}
        >
          {cal.name}
        </label>
        {cal.lastError !== null && (
          <span
            className={styles.warning}
            title={cal.lastError}
            role="img"
            aria-label={`Sync error: ${cal.lastError}`}
            data-testid={`calendar-source-error-${cal.id}`}
          >
            <AlertTriangle size={13} aria-hidden="true" />
          </span>
        )}
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`${cal.name} options`}
          aria-expanded={mode !== "idle"}
          onClick={() => setMode((m) => (m === "idle" ? "menu" : "idle"))}
          data-testid={`calendar-source-menu-${cal.id}`}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </div>
      {mode === "menu" && (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setName(cal.name);
              setMode("rename");
            }}
            data-testid={`calendar-source-rename-${cal.id}`}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => setMode("color")}
            data-testid={`calendar-source-color-${cal.id}`}
          >
            Color
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.danger}`}
            onClick={() => setMode("remove")}
            data-testid={`calendar-source-remove-${cal.id}`}
          >
            Remove
          </button>
        </div>
      )}
      {mode === "rename" && (
        <form className={styles.inlineForm} onSubmit={submitRename}>
          <input
            className={styles.input}
            aria-label="Calendar name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            data-testid={`calendar-source-rename-input-${cal.id}`}
          />
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => setMode("idle")}>
              Cancel
            </button>
            <button type="submit" className={`${styles.button} ${styles.primary}`}>
              Save
            </button>
          </div>
        </form>
      )}
      {mode === "color" && (
        <div className={styles.inlineForm}>
          <ColorSwatches
            value={cal.color}
            onChange={(color) => {
              onUpdate({ color });
              setMode("idle");
            }}
          />
        </div>
      )}
      {mode === "remove" && (
        <div className={styles.inlineForm} role="alertdialog" aria-label="Remove calendar">
          <p className={styles.confirmText}>
            Remove “{cal.name}”? Its events disappear from naiteh; linked notes
            are kept.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => setMode("idle")}>
              Cancel
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.dangerButton}`}
              onClick={() => {
                setMode("idle");
                onRemove();
              }}
              data-testid={`calendar-source-remove-confirm-${cal.id}`}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function ColorSwatches({
  value,
  onChange,
}: {
  value: CalendarColor;
  onChange: (c: CalendarColor) => void;
}) {
  return (
    <div className={styles.swatches} role="radiogroup" aria-label="Color">
      {CALENDAR_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          aria-label={c}
          title={c}
          className={`${styles.swatch} ${c === value ? styles.swatchActive : ""}`}
          style={{ background: calendarColorVar(c) }}
          onClick={() => onChange(c)}
          data-testid={`calendar-swatch-${c}`}
        />
      ))}
    </div>
  );
}

function AddCalendarDialog({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [color, setColor] = useState<CalendarColor>("blue");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (trimmedName === "") {
      setError("Enter a name for the calendar.");
      return;
    }
    if (!isValidFeedUrl(trimmedUrl)) {
      setError("Enter an https:// or webcal:// calendar address.");
      return;
    }
    setSaving(true);
    try {
      await calendarAdd({
        name: trimmedName,
        url: trimmedUrl,
        kind: kindForUrl(trimmedUrl),
        color,
      });
      onAdded();
    } catch (err) {
      setError(formatAppError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className={styles.dialog}
      role="dialog"
      aria-label="Add calendar"
      onSubmit={(e) => void submit(e)}
      noValidate
      data-testid="calendar-add-dialog"
    >
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name</span>
        <input
          className={styles.input}
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          data-testid="calendar-add-name"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Calendar address (iCal URL)</span>
        <input
          className={styles.input}
          value={url}
          placeholder="https://… or webcal://…"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
          data-testid="calendar-add-url"
        />
      </label>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>Color</span>
        <ColorSwatches value={color} onChange={setColor} />
      </div>
      <details className={styles.help}>
        <summary>Where do I find the address?</summary>
        <p>
          <strong>Google:</strong> Settings › your calendar › Integrate
          calendar › “Secret address in iCal format”.
        </p>
        <p>
          <strong>iCloud:</strong> Calendar › share calendar › Public
          Calendar, then copy the webcal link.
        </p>
        <p>Treat the address like a password: anyone with it can read the calendar.</p>
      </details>
      {error !== null && (
        <p className={styles.error} role="alert" data-testid="calendar-add-error">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className={`${styles.button} ${styles.primary}`}
          disabled={saving}
          data-testid="calendar-add-submit"
        >
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
    </form>
  );
}
