import { describe, expect, it } from "vitest";

import capability from "../../../src-tauri/capabilities/default.json";
import closeGuardSource from "../useDraftCloseGuard.ts?raw";

// `core:default` already covers event listen/unlisten (used by
// onCloseRequested); `preventDefault()` is JS-only. The one extra window
// command the close-flush handler invokes is `destroy`, which is NOT in
// `core:window:default`.
describe("Tauri default capability", () => {
  const permissions: readonly unknown[] = capability.permissions;

  it("grants window destroy for the close-requested flush handler", () => {
    expect(closeGuardSource).toMatch(/onCloseRequested\(/);
    expect(closeGuardSource).toMatch(/\.destroy\(\)/);
    expect(permissions).toContain("core:window:allow-destroy");
  });

  it("stays tight: exactly the expected grants, nothing broader", () => {
    expect(permissions).toEqual([
      "core:default",
      "core:window:allow-destroy",
      "dialog:default",
      "dialog:allow-open",
      {
        identifier: "opener:allow-open-url",
        allow: [
          { url: "https://*" },
          { url: "http://*" },
          { url: "mailto:*" },
        ],
      },
    ]);
  });

  it("lets the Markdown viewer open only web and mail links externally", () => {
    // Not `opener:default` (adds tel: and reveal-in-folder), and no
    // open-path: notes can't make the OS open files or other schemes.
    expect(permissions).not.toContain("opener:default");
    expect(JSON.stringify(permissions)).not.toMatch(/open-path|reveal/);
  });
});
