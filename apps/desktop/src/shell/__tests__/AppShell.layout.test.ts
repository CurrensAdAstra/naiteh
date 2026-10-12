import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Read the stylesheet as text: under vitest a `.module.css` import (even
// with `?raw`) goes through the CSS-modules stub, not the file contents.
// Vitest runs with apps/desktop as the working directory.
const shellCss = readFileSync(
  join(process.cwd(), "src", "shell", "AppShell.module.css"),
  "utf8",
);

// jsdom does no layout, so pin the CSS facts that keep the shell fixed
// while a long note scrolls inside the editor panel. Regression: the
// editor grid cell lacked `min-height: 0`, so a long rendered note
// stretched the 1fr row past the window and the whole page scrolled —
// activity bar and status bar included.
function rule(selector: string): string {
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(shellCss);
  if (match === null) throw new Error(`no rule for ${selector}`);
  return match[1] ?? "";
}

describe("AppShell layout", () => {
  it("the shell never scrolls as a whole", () => {
    expect(rule(".shell")).toMatch(/height:\s*100%/);
    expect(rule(".shell")).toMatch(/overflow:\s*hidden/);
  });

  it("every first-row cell may shrink below its content", () => {
    for (const cell of [".activity", ".list", ".resizer", ".editor"]) {
      expect(rule(cell), cell).toMatch(/min-height:\s*0/);
    }
  });

  it("the editor and side panels clip overflow themselves", () => {
    for (const cell of [".list", ".editor"]) {
      expect(rule(cell), cell).toMatch(/overflow:\s*hidden/);
    }
  });

  it("the editor host fills the cell and clips in every mode", () => {
    expect(rule(".editorHost")).toMatch(/height:\s*100%/);
    expect(rule(".editorHost")).toMatch(/min-width:\s*0/);
    expect(rule(".editorHost")).toMatch(/min-height:\s*0/);
    expect(rule(".editorHost")).toMatch(/overflow:\s*hidden/);
  });

  it("calendar mode splits the editor cell into timeline | editor", () => {
    expect(rule(".editorSplit")).toMatch(/display:\s*flex/);
    // Only the calendar split gives the editor a floor; the timeline
    // pane shrinks / collapses first.
    expect(shellCss).toMatch(/\.editorSplit\s*>\s*\.editorHost\s*\{[^}]*min-width:\s*320px/);
    expect(shellCss).toMatch(/\.editorSplit\s*>\s*\.editorHost\s*\{[^}]*flex:\s*1 1 0/);
    // The base grid is untouched: 4 columns, list width from the resizer.
    expect(rule(".shell")).toMatch(/var\(--list-panel-width, 280px\)/);
  });

  it("the timeline pane never scrolls the shell", () => {
    const paneCss = readFileSync(
      join(process.cwd(), "src", "features", "calendar", "DayTimelinePane.module.css"),
      "utf8",
    );
    const timelineCss = readFileSync(
      join(process.cwd(), "src", "features", "calendar", "DayTimeline.module.css"),
      "utf8",
    );
    const r = (sheet: string, sel: string) =>
      new RegExp(`(^|\\n)\\${sel}\\s*\\{([^}]*)\\}`).exec(sheet)?.[2] ?? "";
    expect(r(paneCss, ".pane")).toMatch(/overflow:\s*hidden/);
    expect(r(paneCss, ".pane")).toMatch(/min-height:\s*0/);
    expect(r(paneCss, ".pane")).toMatch(/flex:\s*0 0 auto/);
    expect(r(timelineCss, ".pane")).toMatch(/overflow:\s*hidden/);
    expect(r(timelineCss, ".pane")).toMatch(/min-width:\s*0/);
    expect(r(timelineCss, ".scroll")).toMatch(/min-height:\s*0/);
    expect(r(timelineCss, ".scroll")).toMatch(/overflow-x:\s*hidden/);
    expect(r(timelineCss, ".scroll")).toMatch(/overflow-y:\s*auto/);
  });
});
