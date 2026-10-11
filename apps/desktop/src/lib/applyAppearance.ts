import { PALETTE_TOKENS, getPalette } from "../styles/palettes";
import type { AppearanceConfig } from "./types";

/**
 * Apply an appearance config (wiki app-config.md, `appearance`) to the
 * document root as inline CSS custom properties, overriding the stock
 * values in `styles/tokens.css`.
 *
 * Every palette token is cleared before the new palette's overrides are
 * set, so switching back to `default` restores tokens.css exactly. An
 * empty font string removes the `--font-ui` / `--font-editor` override.
 * Unknown palette ids render as `default`.
 */
export function applyAppearance(
  appearance: AppearanceConfig,
  root: HTMLElement = document.documentElement,
): void {
  const palette = getPalette(appearance.palette);
  const style = root.style;
  for (const token of PALETTE_TOKENS) style.removeProperty(token);
  for (const [token, value] of Object.entries(palette.vars)) {
    style.setProperty(token, value);
  }
  root.dataset.palette = palette.id;
  style.setProperty("color-scheme", palette.scheme);
  setOrClear(style, "--font-ui", appearance.uiFont);
  setOrClear(style, "--font-editor", appearance.editorFont);
}

function setOrClear(style: CSSStyleDeclaration, name: string, value: string) {
  const trimmed = value.trim();
  if (trimmed === "") style.removeProperty(name);
  else style.setProperty(name, trimmed);
}
