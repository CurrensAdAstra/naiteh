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
    for (const cell of [".activity", ".list", ".resizer", ".editor", ".ai"]) {
      expect(rule(cell), cell).toMatch(/min-height:\s*0/);
    }
  });

  it("the editor and side panels clip overflow themselves", () => {
    for (const cell of [".list", ".editor", ".ai"]) {
      expect(rule(cell), cell).toMatch(/overflow:\s*hidden/);
    }
  });
});
