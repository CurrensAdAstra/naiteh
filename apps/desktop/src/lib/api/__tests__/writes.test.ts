import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useVaultStore } from "../../../state/vaultStore";
import { journalSave } from "../journal";
import { notesWrite } from "../notes";

describe("vault-bound write IPC", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useVaultStore.setState({ active: { root: "/B", name: "B", initialized: true } });
  });

  it("sends the captured root explicitly, including new journal entries without a version", async () => {
    await notesWrite("notes/a.md", "A draft", "version-a", "/A");
    await journalSave("2026-10-17", "A journal draft", null, "/A");
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["notes_write", { relPath: "notes/a.md", content: "A draft", expectedVersion: "version-a", expectedVaultRoot: "/A" }],
      ["journal_save", { date: "2026-10-17", content: "A journal draft", expectedVersion: null, expectedVaultRoot: "/A" }],
    ]);
  });

  it("defaults synchronous callers to the current frontend root", async () => {
    await notesWrite("notes/b.md", "B draft", null);
    await journalSave("2026-10-17", "B journal draft", "version-b");
    expect(invoke).toHaveBeenCalledWith("notes_write", expect.objectContaining({ expectedVaultRoot: "/B" }));
    expect(invoke).toHaveBeenCalledWith("journal_save", expect.objectContaining({ expectedVaultRoot: "/B" }));
  });
});
