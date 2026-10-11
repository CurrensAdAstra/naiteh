import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { appConfigSetAppearance } from "../../../lib/api/settings";
import {
  DEFAULT_APPEARANCE,
  formatAppError,
  type AppearanceConfig,
} from "../../../lib/types";
import { useSettingsStore } from "../../../state/settingsStore";
import {
  CUSTOM_FONT_ID as CUSTOM_ID,
  FONT_PRESETS,
  fontPresetIdFor as presetIdFor,
  validateFontFamily,
} from "../../../styles/fontPresets";
import { PALETTES, getPalette } from "../../../styles/palettes";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";
import own from "./AppearanceSection.module.css";

export const FONT_PREVIEW_TEXT = "가나다 The quick brown fox 123";

type FontKey = "uiFont" | "editorFont";

function currentAppearance(): AppearanceConfig {
  return useSettingsStore.getState().config?.appearance ?? DEFAULT_APPEARANCE;
}

export function AppearanceSection() {
  const config = useSettingsStore((s) => s.config);
  const appearance = config?.appearance ?? DEFAULT_APPEARANCE;
  const setSettings = useSettingsStore((s) => s.setConfig);
  const refreshSettings = useSettingsStore((s) => s.refresh);
  const [error, setError] = useState<string | null>(null);
  const activePalette = getPalette(appearance.palette).id;
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);

  async function save(patch: Partial<AppearanceConfig>) {
    const next = { ...currentAppearance(), ...patch };
    setError(null);
    try {
      setSettings(await appConfigSetAppearance(next));
    } catch (e) {
      setError(formatAppError(e));
      await refreshSettings();
    }
  }

  function selectPalette(id: string) {
    if (id === getPalette(currentAppearance().palette).id) return;
    void save({ palette: id });
  }

  function onPaletteKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = PALETTES.length - 1;
    let target: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      target = index === last ? 0 : index + 1;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      target = index === 0 ? last : index - 1;
    } else if (e.key === "Home") {
      target = 0;
    } else if (e.key === "End") {
      target = last;
    }
    if (target === null) return;
    e.preventDefault();
    cardRefs.current[target]?.focus();
    const next = PALETTES[target];
    if (next !== undefined) selectPalette(next.id);
  }

  return (
    <div data-testid="settings-appearance">
      <h2 className={styles.sectionHeading}>Appearance</h2>
      <p className={styles.sectionIntro}>
        Colors and fonts apply immediately on this device.
      </p>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <SettingItem
        name="Color palette"
        description="Surfaces, accents and side panels. Nord and Midnight are dark."
        stacked
      >
        <div
          className={own.paletteGrid}
          role="radiogroup"
          aria-label="Color palette"
          data-testid="palette-picker"
        >
          {PALETTES.map((p, i) => {
            const checked = p.id === activePalette;
            return (
              <button
                key={p.id}
                ref={(el) => {
                  cardRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={p.label}
                title={p.description}
                tabIndex={checked ? 0 : -1}
                className={`${own.paletteCard} ${checked ? own.paletteCardActive : ""}`}
                onClick={() => selectPalette(p.id)}
                onKeyDown={(e) => onPaletteKeyDown(e, i)}
                data-testid={`palette-${p.id}`}
              >
                <span
                  className={own.palettePreview}
                  style={{ background: p.swatches[0] }}
                  aria-hidden="true"
                >
                  <span
                    className={own.previewSide}
                    style={{ background: p.swatches[1] }}
                  />
                  <span className={own.previewBody}>
                    <span
                      className={own.previewLine}
                      style={{ background: p.swatches[3] }}
                    />
                    <span
                      className={`${own.previewLine} ${own.previewLineShort}`}
                      style={{ background: p.swatches[3] }}
                    />
                    <span
                      className={own.previewAccent}
                      style={{ background: p.swatches[2] }}
                    />
                  </span>
                </span>
                <span className={own.paletteLabel}>
                  <span className={own.swatches} aria-hidden="true">
                    {p.swatches.map((c, j) => (
                      <span key={j} className={own.swatch} style={{ background: c }} />
                    ))}
                  </span>
                  {p.label}
                </span>
              </button>
            );
          })}
        </div>
      </SettingItem>
      <FontField
        fontKey="uiFont"
        name="Interface font"
        description="Font for menus, lists and panels."
        value={appearance.uiFont}
        defaultVar="var(--font-ui)"
        onSave={(v) => save({ uiFont: v })}
      />
      <FontField
        fontKey="editorFont"
        name="Editor font"
        description="Font for note text in the editor. Default is monospaced."
        value={appearance.editorFont}
        defaultVar="var(--font-editor)"
        onSave={(v) => save({ editorFont: v })}
      />
      {config === null && (
        <p className={styles.emptyNote}>Loading current values…</p>
      )}
    </div>
  );
}

interface FontFieldProps {
  fontKey: FontKey;
  name: string;
  description: string;
  /** Stored font-family stack ("" = default). */
  value: string;
  /** CSS used to preview the default stack. */
  defaultVar: string;
  onSave: (value: string) => Promise<void>;
}

function FontField({ fontKey, name, description, value, defaultVar, onSave }: FontFieldProps) {
  const selectId = `settings-${fontKey}`;
  const customId = `${selectId}-custom`;
  const storedPreset = presetIdFor(value);
  // "Custom…" chosen but not yet committed keeps the input visible.
  const [customMode, setCustomMode] = useState(storedPreset === CUSTOM_ID);
  const [draft, setDraft] = useState(storedPreset === CUSTOM_ID ? value : "");
  const [draftError, setDraftError] = useState<string | null>(null);
  const editing = useRef(false);

  // Follow the stored value while the user isn't typing.
  useEffect(() => {
    if (editing.current) return;
    if (presetIdFor(value) === CUSTOM_ID) {
      setCustomMode(true);
      setDraft(value);
    }
  }, [value]);

  const selected = customMode ? CUSTOM_ID : storedPreset;
  const showCustom = selected === CUSTOM_ID;

  function onSelect(id: string) {
    setDraftError(null);
    if (id === CUSTOM_ID) {
      setCustomMode(true);
      setDraft(value);
      return;
    }
    setCustomMode(false);
    editing.current = false;
    const preset = FONT_PRESETS.find((p) => p.id === id);
    if (preset !== undefined && preset.stack !== value) void onSave(preset.stack);
  }

  function commitDraft(raw: string) {
    editing.current = false;
    const next = raw.trim();
    const problem = validateFontFamily(next);
    setDraftError(problem);
    if (problem !== null) return;
    if (next === value) return;
    void onSave(next);
  }

  const draftValid = validateFontFamily(draft.trim()) === null;
  const previewStack =
    showCustom && draftValid && draft.trim() !== ""
      ? draft.trim()
      : value !== ""
        ? value
        : defaultVar;

  return (
    <SettingItem name={name} description={description} controlId={selectId}>
      <div className={own.fontControl}>
        <select
          id={selectId}
          className={own.select}
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          aria-describedby={`${selectId}-description`}
          data-testid={`${fontKey}-select`}
        >
          {FONT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value={CUSTOM_ID}>Custom…</option>
        </select>
        {showCustom && (
          <input
            id={customId}
            type="text"
            className={`${styles.textInput} ${own.customInput}`}
            placeholder='e.g. "My Font", sans-serif'
            aria-label={`${name} (custom font-family)`}
            aria-invalid={draftError !== null}
            aria-errormessage={draftError !== null ? `${customId}-error` : undefined}
            value={draft}
            onChange={(e) => {
              editing.current = true;
              setDraft(e.target.value);
              if (draftError !== null) setDraftError(null);
            }}
            onBlur={(e) => commitDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft(e.currentTarget.value);
              }
            }}
            data-testid={`${fontKey}-custom`}
          />
        )}
        {draftError !== null && (
          <span id={`${customId}-error`} className={own.fieldError} role="alert">
            {draftError}
          </span>
        )}
        <span
          className={own.preview}
          style={{ fontFamily: previewStack }}
          data-testid={`${fontKey}-preview`}
        >
          {FONT_PREVIEW_TEXT}
        </span>
      </div>
    </SettingItem>
  );
}
