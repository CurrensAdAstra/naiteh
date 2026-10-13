import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../../../lib/api/backup", () => ({
  backupCompare: vi.fn(),
  backupReadFile: vi.fn(),
  backupRestoreFile: vi.fn(),
}));
vi.mock("../../../lib/api/notes", () => ({ notesVersion: vi.fn() }));
vi.mock("../../../lib/openDocument", () => ({
  openDocument: vi.fn(() => Promise.resolve(true)),
  targetForRelPath: (relPath: string) => ({ kind: "note", relPath }),
}));

import {
  backupCompare,
  backupReadFile,
  backupRestoreFile,
  type CompareReport,
} from "../../../lib/api/backup";
import { notesVersion } from "../../../lib/api/notes";
import { openDocument } from "../../../lib/openDocument";
import { useBackupStore } from "../../../state/backupStore";
import { CompareModal } from "../CompareModal";

const e = (hash: string, size = 10) => ({ size, hash, mtime: 0 });

const report: CompareReport = {
  generatedAt: 0,
  sources: [
    { id: "local", name: "Local", kind: "local", ok: true, error: null, fileCount: 3 },
    { id: "d1", name: "My Drive", kind: "drive", ok: true, error: null, fileCount: 2 },
    { id: "s1", name: "NAS", kind: "sftp", ok: false, error: "timed out", fileCount: 0 },
  ],
  rows: [
    { relPath: "notes/same.md", entries: { local: e("aaaa"), d1: e("aaaa") }, status: "same" },
    { relPath: "notes/changed.md", entries: { local: e("1111"), d1: e("2222", 2048) }, status: "differs" },
    { relPath: "notes/gone.md", entries: { local: e("3333"), d1: null }, status: "missing" },
    { relPath: "img/pic.png", entries: { local: e("4444"), d1: e("5555") }, status: "differs" },
  ],
};

describe("CompareModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBackupStore.setState({ compareOpen: true });
    (backupCompare as Mock).mockImplementation((_deep: boolean, includeSame: boolean) =>
      Promise.resolve(
        includeSame ? report : { ...report, rows: report.rows.filter((r) => r.status !== "same") },
      ),
    );
    (backupReadFile as Mock).mockImplementation((sourceId: string, relPath: string) => {
      if (relPath === "img/pic.png") {
        return Promise.resolve({ content: null, size: 99, hash: `${sourceId}hash`, binary: true });
      }
      const content = sourceId === "local" ? "one\ntwo\nthree\n" : "one\nTWO\nthree\n";
      return Promise.resolve({ content, size: 10, hash: "h", binary: false });
    });
  });

  it("shows sources with status and per-source cells", async () => {
    render(<CompareModal />);
    expect(await screen.findByTestId("compare-source-local")).toHaveTextContent("3 files");
    expect(screen.getByTestId("compare-source-s1")).toHaveTextContent("timed out");
    expect(backupCompare).toHaveBeenCalledWith(false, false);

    const changed = screen.getByTestId("compare-cell-notes/changed.md-d1");
    expect(changed).toHaveTextContent("differs");
    expect(changed).toHaveTextContent("2.0 KB · 2222");
    expect(screen.getByTestId("compare-cell-notes/changed.md-local")).toHaveTextContent("✓ same");
    expect(screen.getByTestId("compare-cell-notes/gone.md-d1")).toHaveTextContent("missing");
    expect(screen.queryByTestId("compare-row-notes/same.md")).not.toBeInTheDocument();
  });

  it("filters by status, shows identical rows, and searches by path", async () => {
    render(<CompareModal />);
    await screen.findByTestId("compare-table");
    fireEvent.click(screen.getByTestId("compare-filter-missing"));
    expect(screen.getAllByRole("row")).toHaveLength(2); // header + gone.md
    expect(screen.getByTestId("compare-row-notes/gone.md")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("compare-filter-changed"));
    expect(screen.queryByTestId("compare-row-notes/gone.md")).not.toBeInTheDocument();
    expect(screen.getByTestId("compare-row-img/pic.png")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("compare-filter-identical"));
    await waitFor(() => expect(backupCompare).toHaveBeenLastCalledWith(false, true));
    expect(await screen.findByTestId("compare-row-notes/same.md")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("compare-search"), { target: { value: "PIC" } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("re-runs with a deep check", async () => {
    render(<CompareModal />);
    await screen.findByTestId("compare-table");
    fireEvent.click(screen.getByTestId("compare-deep"));
    await waitFor(() => expect(backupCompare).toHaveBeenLastCalledWith(true, false));
    fireEvent.click(screen.getByTestId("compare-refresh"));
    await waitFor(() => expect(backupCompare).toHaveBeenCalledTimes(3));
  });

  it("shows a line diff between Local and the chosen backup", async () => {
    render(<CompareModal />);
    fireEvent.click(await screen.findByTestId("compare-row-notes/changed.md"));
    const diff = await screen.findByTestId("compare-diff");
    expect(backupReadFile).toHaveBeenCalledWith("local", "notes/changed.md");
    expect(backupReadFile).toHaveBeenCalledWith("d1", "notes/changed.md");
    const del = diff.querySelector('[data-kind="del"]');
    const add = diff.querySelector('[data-kind="add"]');
    expect(del).toHaveTextContent("two");
    expect(add).toHaveTextContent("TWO");
    // Only targets that answered are offered.
    const select = screen.getByTestId("compare-other");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "My Drive",
    ]);
  });

  it("shows size and hash for binary files", async () => {
    render(<CompareModal />);
    fireEvent.click(await screen.findByTestId("compare-row-img/pic.png"));
    const bin = await screen.findByTestId("compare-binary");
    expect(bin).toHaveTextContent("Local: 99 B · localhash");
    expect(bin).toHaveTextContent("My Drive: 99 B · d1hash");
    expect(screen.queryByTestId("compare-diff")).not.toBeInTheDocument();
  });

  it("restores a copy, refreshes and opens the note", async () => {
    (backupRestoreFile as Mock).mockResolvedValue({ relPath: "notes/changed (backup).md" });
    render(<CompareModal />);
    fireEvent.click(await screen.findByTestId("compare-row-notes/changed.md"));
    await screen.findByTestId("compare-diff");
    fireEvent.click(screen.getByTestId("compare-restore-copy"));
    await waitFor(() =>
      expect(backupRestoreFile).toHaveBeenCalledWith("d1", "notes/changed.md", "copy", null),
    );
    await waitFor(() =>
      expect(openDocument).toHaveBeenCalledWith({
        kind: "note",
        relPath: "notes/changed (backup).md",
      }),
    );
    expect(backupCompare).toHaveBeenCalledTimes(2);
    expect(notesVersion).not.toHaveBeenCalled();
  });

  it("overwrites local after confirming, sending the local version", async () => {
    (notesVersion as Mock).mockResolvedValue("v7");
    (backupRestoreFile as Mock).mockResolvedValue({ relPath: "notes/changed.md" });
    render(<CompareModal />);
    fireEvent.click(await screen.findByTestId("compare-row-notes/changed.md"));
    await screen.findByTestId("compare-diff");
    fireEvent.click(screen.getByTestId("compare-restore-overwrite"));
    expect(backupRestoreFile).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/Replace the local/);
    fireEvent.click(screen.getByTestId("compare-overwrite-confirm"));
    await waitFor(() =>
      expect(backupRestoreFile).toHaveBeenCalledWith(
        "d1",
        "notes/changed.md",
        "overwrite",
        "v7",
      ),
    );
    expect(notesVersion).toHaveBeenCalledWith("notes/changed.md");
  });

  it("surfaces StaleWrite on overwrite", async () => {
    (notesVersion as Mock).mockResolvedValue("v7");
    (backupRestoreFile as Mock).mockRejectedValue({ kind: "StaleWrite", message: "v8" });
    render(<CompareModal />);
    fireEvent.click(await screen.findByTestId("compare-row-notes/changed.md"));
    await screen.findByTestId("compare-diff");
    fireEvent.click(screen.getByTestId("compare-restore-overwrite"));
    fireEvent.click(screen.getByTestId("compare-overwrite-confirm"));
    expect(await screen.findByTestId("compare-error")).toHaveTextContent(
      /changed while you were comparing/,
    );
    expect(openDocument).not.toHaveBeenCalled();
  });

  it("disables restore when the backup has no copy", async () => {
    render(<CompareModal />);
    fireEvent.click(await screen.findByTestId("compare-row-notes/gone.md"));
    await screen.findByTestId("compare-diff");
    expect(screen.getByTestId("compare-restore-copy")).toBeDisabled();
    expect(backupReadFile).not.toHaveBeenCalledWith("d1", "notes/gone.md");
  });

  it("closes from the close button and Escape", async () => {
    render(<CompareModal />);
    await screen.findByTestId("compare-table");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useBackupStore.getState().compareOpen).toBe(false);
  });
});
