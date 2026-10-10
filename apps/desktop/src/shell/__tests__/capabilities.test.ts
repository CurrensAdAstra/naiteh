import { describe, expect, it } from "vitest";

import capability from "../../../src-tauri/capabilities/default.json";
import lifecycleSource from "../useWorkspaceLifecycle.ts?raw";

// `core:default` already covers event listen/unlisten (used by
// onCloseRequested); `preventDefault()` is JS-only. The one extra window
// command the close-flush handler invokes is `destroy`, which is NOT in
// `core:window:default`.
describe("Tauri default capability", () => {
  const permissions: readonly unknown[] = capability.permissions;

  it("grants window destroy for the close-requested flush handler", () => {
    expect(lifecycleSource).toMatch(/onCloseRequested\(/);
    expect(lifecycleSource).toMatch(/\.destroy\(\)/);
    expect(permissions).toContain("core:window:allow-destroy");
  });

  it("stays tight: exactly the expected grants, nothing broader", () => {
    expect(permissions).toEqual([
      "core:default",
      "core:window:allow-destroy",
      "dialog:default",
      "dialog:allow-open",
    ]);
  });
});
