import { describe, expect, it } from "vitest";

import { toggleTaskAt } from "../markdownTasks";

describe("toggleTaskAt", () => {
  it("checks and unchecks the item at the offset", () => {
    const src = "- [ ] one\n- [x] two\n";
    expect(toggleTaskAt(src, 0)).toBe("- [x] one\n- [x] two\n");
    expect(toggleTaskAt(src, 10)).toBe("- [ ] one\n- [ ] two\n");
  });

  it("handles ordered and alternate bullets, and capital X", () => {
    expect(toggleTaskAt("1. [ ] a", 0)).toBe("1. [x] a");
    expect(toggleTaskAt("12) [X] a", 0)).toBe("12) [ ] a");
    expect(toggleTaskAt("* [ ] a", 0)).toBe("* [x] a");
    expect(toggleTaskAt("+\t[ ] a", 0)).toBe("+\t[x] a");
  });

  it("toggles a nested item without touching its parent", () => {
    const src = "- [ ] parent\n  - [ ] child\n";
    expect(toggleTaskAt(src, src.indexOf("- [ ] child"))).toBe(
      "- [ ] parent\n  - [x] child\n",
    );
  });

  it("returns null when there is no task marker at the offset", () => {
    expect(toggleTaskAt("- plain item", 0)).toBeNull();
    expect(toggleTaskAt("text - [ ] not here", 0)).toBeNull();
    expect(toggleTaskAt("- [ ] a", -1)).toBeNull();
    expect(toggleTaskAt("- [ ] a", 99)).toBeNull();
  });
});
