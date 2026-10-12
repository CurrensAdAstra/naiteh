import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CALENDAR_COLORS } from "../../../lib/types";
import { PALETTES } from "../../../styles/palettes";

// Read stylesheets as text (vitest stubs `.module.css` imports).
// Vitest runs with apps/desktop as the working directory.
function css(...parts: string[]): string {
  return readFileSync(join(process.cwd(), "src", ...parts), "utf8");
}

const panelCss = css("features", "calendar", "CalendarListPanel.module.css");
const sourcesCss = css("features", "calendar", "CalendarSources.module.css");
const gridCss = css("features", "calendar", "CalendarGrid.module.css");
const tokensCss = css("styles", "tokens.css");

function rule(sheet: string, selector: string): string {
  const match = new RegExp(`(^|\\n)\\${selector}\\s*\\{([^}]*)\\}`).exec(sheet);
  if (match === null) throw new Error(`no rule for ${selector}`);
  return match[2] ?? "";
}

// jsdom does no layout, so pin the CSS facts that keep the calendar
// panel inside its 200–480px list column (a full-width calendar once
// broke the shell).
describe("calendar panel CSS cannot overflow horizontally", () => {
  it("clips horizontal overflow at the panel and its scroll areas", () => {
    expect(rule(panelCss, ".panel")).toMatch(/overflow:\s*hidden/);
    expect(rule(panelCss, ".panel")).toMatch(/min-width:\s*0/);
    expect(rule(panelCss, ".body")).toMatch(/overflow-x:\s*hidden/);
    expect(rule(panelCss, ".body")).toMatch(/min-width:\s*0/);
    expect(rule(sourcesCss, ".section")).toMatch(/overflow:\s*hidden/);
    expect(rule(sourcesCss, ".body")).toMatch(/overflow-x:\s*hidden/);
  });

  it("lets flex children shrink and long text ellipsize", () => {
    for (const sel of [".eventMain", ".eventToggle", ".itemTitle", ".tab"]) {
      expect(rule(panelCss, sel)).toMatch(/min-width:\s*0/);
    }
    expect(rule(panelCss, ".eventTitle")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(sourcesCss, ".name")).toMatch(/min-width:\s*0/);
    expect(rule(sourcesCss, ".name")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(sourcesCss, ".input")).toMatch(/min-width:\s*0/);
  });

  it("uses shrinkable grid tracks for the mini calendar", () => {
    expect(gridCss).toMatch(/repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
    expect(rule(gridCss, ".cell")).toMatch(/min-width:\s*0/);
  });

  it("declares no fixed widths wider than the narrowest panel", () => {
    for (const sheet of [panelCss, sourcesCss, gridCss]) {
      for (const m of sheet.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*(\d+)px/g)) {
        expect(Number(m[1])).toBeLessThan(200);
      }
      expect(sheet).not.toMatch(/100vw/);
    }
  });
});

describe("calendar color tokens", () => {
  const tokens = CALENDAR_COLORS.map((c) => `--color-cal-${c}`);

  it("are declared in tokens.css", () => {
    for (const t of tokens) expect(tokensCss).toContain(`${t}:`);
  });

  it("are overridden by every non-default palette, dark ones included", () => {
    for (const p of PALETTES.filter((x) => x.id !== "default")) {
      for (const t of tokens) {
        expect((p.vars as Record<string, string>)[t], `${p.id} ${t}`).toMatch(
          /^#[0-9a-f]{6}$/,
        );
      }
    }
  });
});
