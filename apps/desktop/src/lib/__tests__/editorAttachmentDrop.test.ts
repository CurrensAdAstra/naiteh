import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/attachments", () => ({
  attachmentsImportBytes: vi.fn(),
}));
vi.mock("../../state/editorStore", () => ({
  insertAtCursor: vi.fn(),
}));

import { attachmentsImportBytes } from "../api/attachments";
import {
  eventHasFiles,
  filesFromClipboard,
  MAX_ATTACHMENT_BYTES,
  uploadAndInsert,
} from "../editorAttachmentDrop";
import { insertAtCursor } from "../../state/editorStore";

const mockedImportBytes = vi.mocked(attachmentsImportBytes);
const mockedInsert = vi.mocked(insertAtCursor);

function makeFile(name: string, type: string, bytes = "hello"): File {
  return new File([bytes], name, { type });
}

function makeOversizeFile(name: string): File {
  const f = makeFile(name, "image/png", "x");
  // Faking size avoids allocating 50 MB in the test.
  Object.defineProperty(f, "size", { value: MAX_ATTACHMENT_BYTES + 1 });
  return f;
}

// jsdom doesn't ship DataTransfer/DataTransferItemList, so we hand-roll
// the slice of shape our helpers actually touch.
type FakeDT = Pick<DataTransfer, "items" | "types">;

function fakeClipboard(items: Array<File | string>): FakeDT {
  return {
    items: items.map((it): { kind: string; getAsFile: () => File | null } =>
      typeof it === "string"
        ? { kind: "string", getAsFile: () => null }
        : { kind: "file", getAsFile: () => it },
    ) as unknown as DataTransferItemList,
    types: items.some((it) => it instanceof File)
      ? (["Files"] as unknown as DataTransfer["types"])
      : (items
          .filter((it): it is string => typeof it === "string")
          .map(() => "text/plain") as unknown as DataTransfer["types"]),
  };
}

describe("filesFromClipboard", () => {
  it("returns only file items, skipping strings", () => {
    const dt = fakeClipboard([makeFile("a.png", "image/png"), "hello"]);
    const out = filesFromClipboard(dt as DataTransfer);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("a.png");
  });

  it("returns empty array when clipboard is null", () => {
    expect(filesFromClipboard(null)).toEqual([]);
  });
});

describe("eventHasFiles", () => {
  it("detects file drops by the 'Files' type marker", () => {
    const dt = fakeClipboard([makeFile("a.png", "image/png")]);
    expect(eventHasFiles(dt as DataTransfer)).toBe(true);
  });

  it("returns false for text-only data transfers", () => {
    const dt = fakeClipboard(["hello"]);
    expect(eventHasFiles(dt as DataTransfer)).toBe(false);
  });

  it("returns false when dataTransfer is null", () => {
    expect(eventHasFiles(null)).toBe(false);
  });
});

describe("uploadAndInsert", () => {
  beforeEach(() => {
    mockedImportBytes.mockReset();
    mockedInsert.mockReset();
    mockedInsert.mockReturnValue(true);
  });

  it("rejects an oversized file without calling the IPC", async () => {
    const onError = vi.fn();
    await uploadAndInsert([makeOversizeFile("huge.png")], onError);

    expect(mockedImportBytes).not.toHaveBeenCalled();
    expect(mockedInsert).not.toHaveBeenCalled();
    const messages = onError.mock.calls
      .map((c) => c[0])
      .filter((m): m is string => typeof m === "string");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/too large/i);
  });

  it("uploads each file and inserts the joined markdown", async () => {
    mockedImportBytes
      .mockResolvedValueOnce({
        relPath: "attachments/a.png",
        fileName: "a.png",
        markdown: "![a](attachments/a.png)",
      })
      .mockResolvedValueOnce({
        relPath: "attachments/b.pdf",
        fileName: "b.pdf",
        markdown: "[b](attachments/b.pdf)",
      });
    const onError = vi.fn();

    await uploadAndInsert(
      [makeFile("a.png", "image/png"), makeFile("b.pdf", "application/pdf")],
      onError,
    );

    expect(mockedImportBytes).toHaveBeenCalledTimes(2);
    expect(mockedImportBytes).toHaveBeenNthCalledWith(
      1,
      expect.any(Uint8Array),
      "a.png",
      "image/png",
    );
    expect(mockedInsert).toHaveBeenCalledWith(
      "![a](attachments/a.png)\n\n[b](attachments/b.pdf)",
    );
    expect(onError).toHaveBeenCalledWith(null); // cleared on entry
    // Should not have been called with an error string.
    expect(onError.mock.calls.every((c) => c[0] === null)).toBe(true);
  });

  it("passes null for empty MIME so the backend synthesizes the name", async () => {
    mockedImportBytes.mockResolvedValue({
      relPath: "attachments/paste-x.bin",
      fileName: "paste-x.bin",
      markdown: "[x](attachments/paste-x.bin)",
    });
    await uploadAndInsert([makeFile("x", "")], vi.fn());
    expect(mockedImportBytes).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "x",
      null,
    );
  });

  it("surfaces upload failures via onError and stops the batch", async () => {
    mockedImportBytes.mockRejectedValueOnce({
      kind: "Io",
      message: "disk full",
    });
    const onError = vi.fn();

    await uploadAndInsert(
      [makeFile("a.png", "image/png"), makeFile("b.png", "image/png")],
      onError,
    );

    expect(mockedImportBytes).toHaveBeenCalledTimes(1);
    expect(mockedInsert).not.toHaveBeenCalled();
    const errorMessages = onError.mock.calls
      .map((c) => c[0])
      .filter((m): m is string => typeof m === "string");
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]).toMatch(/disk full/);
  });

  it("warns when no note is open (insertAtCursor returns false)", async () => {
    mockedImportBytes.mockResolvedValue({
      relPath: "attachments/a.png",
      fileName: "a.png",
      markdown: "![a](attachments/a.png)",
    });
    mockedInsert.mockReturnValue(false);
    const onError = vi.fn();

    await uploadAndInsert([makeFile("a.png", "image/png")], onError);

    const errorMessages = onError.mock.calls
      .map((c) => c[0])
      .filter((m): m is string => typeof m === "string");
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]).toMatch(/open a note/i);
  });
});
