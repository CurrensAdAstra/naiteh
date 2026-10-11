import { useMemo, useState } from "react";

import { appConfigSetClipping } from "../../../lib/api/settings";
import { htmlToMarkdown, sanitizeHtml } from "../../../lib/htmlToMarkdown";
import {
  DEFAULT_CLIPPING,
  formatAppError,
  type ClippingConfig,
} from "../../../lib/types";
import {
  selectClippingConfig,
  useSettingsStore,
} from "../../../state/settingsStore";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";
import local from "./ClippingSection.module.css";

/** Fixed sample run through the converter for the live preview. */
export const PREVIEW_HTML = `<h1>Clipped article</h1>
<h2>Section</h2>
<p>Some <strong>bold</strong> and <em>italic</em> text with a
<a href="https://example.com/docs" title="Docs">link</a> and <code>inline code</code>.</p>
<ul><li>First item</li><li>Second item<ul><li>Nested</li></ul></li></ul>
<pre><code class="language-js">const answer = 42;
console.log(answer);</code></pre>
<table><thead><tr><th>Name</th><th>Value</th></tr></thead>
<tbody><tr><td>alpha</td><td>1</td></tr><tr><td>beta</td><td>2</td></tr></tbody></table>
<p><img src="https://example.com/cat.png" alt="A cat"></p>`;

const PREVIEW_PLAIN = `Clipped article
Section
Some bold and italic text with a link and inline code.
First item
Second item
Nested
const answer = 42;
console.log(answer);
Name	Value
alpha	1
beta	2`;

type OptionKey = Exclude<keyof ClippingConfig, "htmlPaste">;

interface Field {
  key: OptionKey;
  name: string;
  description: string;
  options: { value: string; label: string }[];
}

const MODE_ID = "settings-clipping-mode";

const MODE_OPTIONS: { value: ClippingConfig["htmlPaste"]; label: string }[] = [
  { value: "markdown", label: "Convert to Markdown" },
  { value: "plain", label: "Paste as plain text" },
  { value: "html", label: "Keep raw HTML" },
];

const FIELDS: Field[] = [
  {
    key: "headingStyle",
    name: "Headings",
    description: "Setext underlines apply to levels 1–2; deeper levels use #.",
    options: [
      { value: "atx", label: "# Heading" },
      { value: "setext", label: "Heading + ===" },
    ],
  },
  {
    key: "bulletMarker",
    name: "Bullet marker",
    description: "Marker used for unordered list items.",
    options: [
      { value: "-", label: "- (dash)" },
      { value: "*", label: "* (asterisk)" },
      { value: "+", label: "+ (plus)" },
    ],
  },
  {
    key: "codeBlockStyle",
    name: "Code blocks",
    description: "Fenced blocks keep the language when the page declares it.",
    options: [
      { value: "fenced", label: "Fenced (```)" },
      { value: "indented", label: "Indented (4 spaces)" },
    ],
  },
  {
    key: "emphasis",
    name: "Italic",
    description: "Delimiter for emphasised text.",
    options: [
      { value: "_", label: "_italic_" },
      { value: "*", label: "*italic*" },
    ],
  },
  {
    key: "strong",
    name: "Bold",
    description: "Delimiter for strong text.",
    options: [
      { value: "**", label: "**bold**" },
      { value: "__", label: "__bold__" },
    ],
  },
  {
    key: "linkStyle",
    name: "Links",
    description: "Reference links are listed at the end of the pasted block.",
    options: [
      { value: "inline", label: "Inline [text](url)" },
      { value: "reference", label: "Reference [text][1]" },
    ],
  },
  {
    key: "images",
    name: "Images",
    description: "Keep images as ![alt](src) links or leave them out.",
    options: [
      { value: "keep", label: "Keep" },
      { value: "drop", label: "Drop" },
    ],
  },
  {
    key: "tables",
    name: "Tables",
    description: "GitHub-style pipe tables, sanitized HTML, or one line per row.",
    options: [
      { value: "gfm", label: "Markdown table" },
      { value: "html", label: "HTML table" },
      { value: "text", label: "Plain text rows" },
    ],
  },
];

function sameConfig(a: ClippingConfig, b: ClippingConfig): boolean {
  return (Object.keys(b) as (keyof ClippingConfig)[]).every(
    (k) => a[k] === b[k],
  );
}

export function ClippingSection() {
  const config = useSettingsStore((s) => s.config);
  const clipping = useSettingsStore(selectClippingConfig);
  const setSettings = useSettingsStore((s) => s.setConfig);
  const refreshSettings = useSettingsStore((s) => s.refresh);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(next: ClippingConfig) {
    setError(null);
    setBusy(true);
    try {
      setSettings(await appConfigSetClipping(next));
    } catch (e) {
      setError(formatAppError(e));
      await refreshSettings();
    } finally {
      setBusy(false);
    }
  }

  function update<K extends keyof ClippingConfig>(
    key: K,
    value: ClippingConfig[K],
  ) {
    // Read the latest stored value so quick successive edits compose.
    const current = selectClippingConfig(useSettingsStore.getState());
    if (current[key] === value) return;
    void save({ ...current, [key]: value });
  }

  const preview = useMemo(() => {
    if (clipping.htmlPaste === "plain") return PREVIEW_PLAIN;
    if (clipping.htmlPaste === "html") return sanitizeHtml(PREVIEW_HTML);
    return htmlToMarkdown(PREVIEW_HTML, clipping);
  }, [clipping]);

  const converting = clipping.htmlPaste === "markdown";
  const isDefault = sameConfig(clipping, DEFAULT_CLIPPING);

  return (
    <div data-testid="settings-clipping">
      <h2 className={styles.sectionHeading}>Web Clipping</h2>
      <p className={styles.sectionIntro}>
        How HTML copied from a web page or document becomes text when you
        paste it into a note. Image pastes are always saved as attachments,
        and pastes inside code blocks stay plain text.
      </p>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <SettingItem
        name="When pasting HTML"
        description="Convert formatting to Markdown, keep only the plain text, or insert the (sanitized) HTML source."
        controlId={MODE_ID}
      >
        <select
          id={MODE_ID}
          className={local.select}
          value={clipping.htmlPaste}
          onChange={(e) =>
            update("htmlPaste", e.target.value as ClippingConfig["htmlPaste"])
          }
          disabled={busy}
          aria-describedby={`${MODE_ID}-description`}
          data-testid="clipping-htmlPaste"
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </SettingItem>
      <div
        className={local.options}
        aria-disabled={!converting}
        data-testid="clipping-markdown-options"
      >
        <h3 className={styles.groupHeading}>Markdown conversion</h3>
        {!converting && (
          <p className={styles.emptyNote}>
            These options apply when pasting is set to “Convert to Markdown”.
          </p>
        )}
        {FIELDS.map((f) => {
          const id = `settings-clipping-${f.key}`;
          return (
            <SettingItem
              key={f.key}
              name={f.name}
              description={f.description}
              controlId={id}
            >
              <select
                id={id}
                className={local.select}
                value={clipping[f.key]}
                onChange={(e) =>
                  update(f.key, e.target.value as ClippingConfig[OptionKey])
                }
                disabled={busy || !converting}
                aria-describedby={`${id}-description`}
                data-testid={`clipping-${f.key}`}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </SettingItem>
          );
        })}
      </div>
      <SettingItem
        name="Preview"
        description="A sample web snippet pasted with the current settings."
        stacked
      >
        <pre className={local.preview} data-testid="clipping-preview">
          {preview}
        </pre>
      </SettingItem>
      <div className={styles.actionRow}>
        <button
          type="button"
          className={styles.button}
          onClick={() => void save({ ...DEFAULT_CLIPPING })}
          disabled={busy || isDefault}
          data-testid="clipping-reset"
        >
          Reset to defaults
        </button>
      </div>
      {config === null && (
        <p className={styles.emptyNote}>Loading current values…</p>
      )}
    </div>
  );
}
