import { FONT_FAMILY_MAX_LEN } from "../lib/types";

/**
 * Font presets for Settings > Appearance (`appearance.uiFont` /
 * `appearance.editorFont`). Each preset saves a full CSS `font-family`
 * stack with Korean and generic fallbacks; the config stores the stack
 * itself, so a value matching no preset is shown as "Custom…".
 */
export interface FontPreset {
  id: string;
  label: string;
  /** Empty = built-in default stack from styles/tokens.css. */
  stack: string;
}

export const FONT_PRESETS: readonly FontPreset[] = [
  { id: "default", label: "Default (system)", stack: "" },
  {
    id: "noto-sans-kr",
    label: "Noto Sans KR",
    stack: '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
  },
  {
    id: "pretendard",
    label: "Pretendard",
    stack:
      'Pretendard, "Pretendard Variable", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
  },
  {
    id: "inter",
    label: "Inter",
    stack: 'Inter, "Segoe UI", "Noto Sans KR", "Malgun Gothic", sans-serif',
  },
  {
    id: "segoe-ui",
    label: "Segoe UI",
    stack: '"Segoe UI", "Malgun Gothic", "Noto Sans KR", sans-serif',
  },
  {
    id: "malgun-gothic",
    label: "Malgun Gothic / 맑은 고딕",
    stack: '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", sans-serif',
  },
  {
    id: "nanum-gothic",
    label: "Nanum Gothic",
    stack:
      '"Nanum Gothic", "나눔고딕", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
  },
  {
    id: "georgia",
    label: "Georgia (serif)",
    stack: 'Georgia, "Noto Serif KR", "Nanum Myeongjo", serif',
  },
  {
    id: "noto-serif-kr",
    label: "Noto Serif KR",
    stack: '"Noto Serif KR", "Nanum Myeongjo", AppleMyungjo, Georgia, serif',
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    stack: '"JetBrains Mono", D2Coding, Consolas, "Malgun Gothic", monospace',
  },
  {
    id: "consolas",
    label: "Consolas",
    stack: 'Consolas, D2Coding, "Malgun Gothic", monospace',
  },
  {
    id: "d2coding",
    label: "D2Coding",
    stack: 'D2Coding, "D2Coding ligature", Consolas, "Malgun Gothic", monospace',
  },
];

/** Select value for a stack that matches no preset. */
export const CUSTOM_FONT_ID = "custom";

/** Preset id whose stack equals `stack`, else {@link CUSTOM_FONT_ID}. */
export function fontPresetIdFor(stack: string): string {
  return FONT_PRESETS.find((p) => p.stack === stack)?.id ?? CUSTOM_FONT_ID;
}

/**
 * Mirrors `validate_font_family` in services/config.rs: at most
 * FONT_FAMILY_MAX_LEN characters, no `; { } < > \` and no control
 * characters. Returns an error message, or null when valid.
 */
export function validateFontFamily(value: string): string | null {
  const chars = [...value];
  if (chars.length > FONT_FAMILY_MAX_LEN) {
    return `Font family must be at most ${FONT_FAMILY_MAX_LEN} characters.`;
  }
  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return "Font family must not contain control characters.";
    }
    if (";{}<>\\".includes(ch)) {
      return `Font family must not contain "${ch}".`;
    }
  }
  return null;
}
