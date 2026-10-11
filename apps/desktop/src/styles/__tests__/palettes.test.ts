import { describe, expect, it } from "vitest";

import { PALETTE_IDS } from "../../lib/types";
import { PALETTES, PALETTE_TOKENS, getPalette, type Palette } from "../palettes";

/** Stock values from styles/tokens.css, which `default` inherits. */
const TOKEN_DEFAULTS: Record<string, string> = {
  "--color-bg-app": "#ffffff",
  "--color-bg-listpanel": "#f3f3f3",
  "--color-bg-editor": "#ffffff",
  "--color-text-primary": "#3b3b3b",
  "--color-text-secondary": "#616161",
  "--color-text-inverse": "#ffffff",
  "--color-accent": "#005fb8",
  "--color-selection": "#cce4f7",
};

function resolve(p: Palette, token: string): string {
  const v = (p.vars as Record<string, string>)[token] ?? TOKEN_DEFAULTS[token];
  if (v === undefined) throw new Error(`no value for ${token}`);
  return v;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * lin((n >> 16) & 255) +
    0.7152 * lin((n >> 8) & 255) +
    0.0722 * lin(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("palettes", () => {
  it("defines exactly the backend's palette ids, in order", () => {
    expect(PALETTES.map((p) => p.id)).toEqual([...PALETTE_IDS]);
  });

  it("keeps the default palette override-free", () => {
    expect(getPalette("default").vars).toEqual({});
  });

  it("falls back to default for unknown ids", () => {
    expect(getPalette("nope").id).toBe("default");
  });

  it("only overrides known tokens with hex colors", () => {
    for (const p of PALETTES) {
      for (const [k, v] of Object.entries(p.vars)) {
        expect(PALETTE_TOKENS).toContain(k);
        expect(v).toMatch(/^#[0-9a-f]{6}$/);
      }
      for (const s of p.swatches) expect(s).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("overrides every token in non-default palettes", () => {
    for (const p of PALETTES.filter((x) => x.id !== "default")) {
      expect(Object.keys(p.vars).sort()).toEqual([...PALETTE_TOKENS].sort());
    }
  });

  it("marks nord and midnight as dark schemes", () => {
    expect(PALETTES.filter((p) => p.scheme === "dark").map((p) => p.id)).toEqual([
      "nord",
      "midnight",
    ]);
  });

  it.each(PALETTES.map((p) => [p.id, p] as const))(
    "%s meets WCAG AA for text and accent",
    (_id, p) => {
      const surfaces = [
        "--color-bg-app",
        "--color-bg-listpanel",
        "--color-bg-editor",
      ];
      for (const s of surfaces) {
        const bg = resolve(p, s);
        expect(contrast(resolve(p, "--color-text-primary"), bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(resolve(p, "--color-text-secondary"), bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(resolve(p, "--color-accent"), bg)).toBeGreaterThanOrEqual(4.5);
      }
      // Primary buttons: inverse text on accent fill.
      expect(
        contrast(resolve(p, "--color-text-inverse"), resolve(p, "--color-accent")),
      ).toBeGreaterThanOrEqual(4.5);
      // Selected rows keep primary text readable.
      expect(
        contrast(resolve(p, "--color-text-primary"), resolve(p, "--color-selection")),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});
