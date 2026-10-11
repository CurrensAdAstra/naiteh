import { beforeEach, describe, expect, it } from "vitest";

import { getPalette } from "../../styles/palettes";
import { applyAppearance } from "../applyAppearance";
import { DEFAULT_APPEARANCE } from "../types";

describe("applyAppearance", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
  });

  it("sets the palette's vars, data-palette and color-scheme", () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, palette: "nord" }, root);
    const nord = getPalette("nord");
    expect(root.dataset.palette).toBe("nord");
    expect(root.style.getPropertyValue("color-scheme")).toBe("dark");
    expect(root.style.getPropertyValue("--color-bg-app")).toBe(
      nord.vars["--color-bg-app"],
    );
    expect(root.style.getPropertyValue("--color-accent")).toBe(
      nord.vars["--color-accent"],
    );
  });

  it("removes the previous palette's vars when switching back to default", () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, palette: "ocean" }, root);
    expect(root.style.getPropertyValue("--color-accent")).not.toBe("");
    applyAppearance(DEFAULT_APPEARANCE, root);
    expect(root.style.getPropertyValue("--color-accent")).toBe("");
    expect(root.style.getPropertyValue("--color-bg-app")).toBe("");
    expect(root.dataset.palette).toBe("default");
    expect(root.style.getPropertyValue("color-scheme")).toBe("light");
  });

  it("treats an unknown palette as default", () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, palette: "forest" }, root);
    applyAppearance({ ...DEFAULT_APPEARANCE, palette: "neon" }, root);
    expect(root.dataset.palette).toBe("default");
    expect(root.style.getPropertyValue("--color-accent")).toBe("");
  });

  it("sets font overrides and clears them when empty", () => {
    applyAppearance(
      { palette: "default", uiFont: "Inter, sans-serif", editorFont: "D2Coding, monospace" },
      root,
    );
    expect(root.style.getPropertyValue("--font-ui")).toBe("Inter, sans-serif");
    expect(root.style.getPropertyValue("--font-editor")).toBe("D2Coding, monospace");

    applyAppearance({ palette: "default", uiFont: "", editorFont: "  " }, root);
    expect(root.style.getPropertyValue("--font-ui")).toBe("");
    expect(root.style.getPropertyValue("--font-editor")).toBe("");
  });

  it("defaults to document.documentElement", () => {
    applyAppearance({ ...DEFAULT_APPEARANCE, palette: "midnight" });
    expect(document.documentElement.dataset.palette).toBe("midnight");
    applyAppearance(DEFAULT_APPEARANCE);
    expect(document.documentElement.style.getPropertyValue("--color-bg-app")).toBe("");
  });
});
