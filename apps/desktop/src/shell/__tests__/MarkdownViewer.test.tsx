import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/api/attachments", () => ({
  attachmentsReadImage: vi.fn(),
}));
vi.mock("../../lib/openDocument", () => ({
  openDocument: vi.fn(),
  targetForRelPath: (relPath: string) => ({ kind: "note", relPath }),
}));

import { openUrl } from "@tauri-apps/plugin-opener";

import { attachmentsReadImage } from "../../lib/api/attachments";
import { openDocument } from "../../lib/openDocument";
import type { AppError } from "../../lib/types";
import { clearViewerImageCache } from "../../lib/viewerImages";
import { MarkdownViewer } from "../MarkdownViewer";

const mockedOpenUrl = vi.mocked(openUrl);
const mockedReadImage = vi.mocked(attachmentsReadImage);
const mockedOpenDocument = vi.mocked(openDocument);
const notFound: AppError = { kind: "NotFound", message: "x" };

function show(
  content: string,
  docRelPath = "notes/a.md",
  onChange = vi.fn(),
  onStartEditing = vi.fn(),
) {
  const utils = render(
    <MarkdownViewer
      content={content}
      docRelPath={docRelPath}
      onChange={onChange}
      onStartEditing={onStartEditing}
    />,
  );
  return { ...utils, onChange, onStartEditing };
}

describe("MarkdownViewer", () => {
  beforeEach(() => {
    clearViewerImageCache();
    mockedOpenUrl.mockClear();
    mockedReadImage.mockReset();
    mockedReadImage.mockRejectedValue(notFound);
    mockedOpenDocument.mockReset();
  });

  it("renders GFM and hides the front matter", () => {
    show(
      "---\ntitle: Secret title\ntags: [x]\n---\n# Hello\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~ **bold**\n",
    );
    expect(screen.getByRole("heading", { name: "Hello" })).toHaveAttribute(
      "id",
      "hello",
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("old").tagName).toBe("DEL");
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.queryByText(/secret title/i)).not.toBeInTheDocument();
  });

  it("sanitizes raw HTML", () => {
    const { container } = show(
      '<b>kept</b>\n\n<script>window.pwned = 1</script>\n\n<img src="x.png" onerror="alert(1)">\n\n<a href="javascript:alert(1)">bad</a>\n',
    );
    expect(screen.getByText("kept").tagName).toBe("B");
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror/i);
    expect(container.innerHTML).not.toMatch(/javascript:/i);
  });

  it("opens external links in the system browser, never in the webview", () => {
    show("[site](https://example.com)");
    const link = screen.getByRole("link", { name: "site" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(mockedOpenUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("ignores javascript: links", () => {
    show("[x](javascript:alert(1))");
    // The sanitizer drops the href; if it survived, the click is blocked.
    fireEvent.click(screen.getByText("x"));
    expect(mockedOpenUrl).not.toHaveBeenCalled();
    expect(mockedOpenDocument).not.toHaveBeenCalled();
  });

  it("opens linked notes, falling back from note- to vault-relative", async () => {
    mockedOpenDocument
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce(true);
    show("[next](journal/2026/05/2026-05-09.md)", "notes/a.md");
    fireEvent.click(screen.getByRole("link", { name: "next" }));
    await waitFor(() => expect(mockedOpenDocument).toHaveBeenCalledTimes(2));
    expect(mockedOpenDocument.mock.calls[0]?.[0]).toEqual({
      kind: "note",
      relPath: "notes/journal/2026/05/2026-05-09.md",
    });
    expect(mockedOpenDocument.mock.calls[1]?.[0]).toEqual({
      kind: "note",
      relPath: "journal/2026/05/2026-05-09.md",
    });
  });

  it("says so when a linked note does not exist", async () => {
    mockedOpenDocument.mockRejectedValue(notFound);
    show("[gone](missing.md)");
    fireEvent.click(screen.getByRole("link", { name: "gone" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Linked note not found: missing.md",
    );
  });

  it("loads vault images through the backend", async () => {
    mockedReadImage.mockResolvedValue("data:image/png;base64,AAA");
    show("![shot](attachments/shot.png)", "notes/a.md");
    const img = await screen.findByRole("img", { name: "shot" });
    expect(img).toHaveAttribute("src", "data:image/png;base64,AAA");
    expect(mockedReadImage).toHaveBeenCalledWith([
      "notes/attachments/shot.png",
      "attachments/shot.png",
    ]);
  });

  it("shows a placeholder for a missing image", async () => {
    mockedReadImage.mockRejectedValue(notFound);
    show("![gone](attachments/gone.png)");
    expect(await screen.findByRole("img", { name: "gone" })).toHaveTextContent(
      "Image not found: attachments/gone.png",
    );
  });

  it("does not fetch remote images", () => {
    show("![tracker](https://x.test/pixel.png)");
    expect(screen.getByText(/remote image not loaded: tracker/i)).toBeInTheDocument();
    expect(mockedReadImage).not.toHaveBeenCalled();
  });

  it("toggles a task in the source, accounting for front matter", () => {
    const content = "---\ntags: [x]\n---\n- [ ] one\n- [ ] two\n\n```\n- [ ] code\n```\n";
    const { onChange } = show(content);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[1]!);
    expect(onChange).toHaveBeenCalledWith(
      "---\ntags: [x]\n---\n- [ ] one\n- [x] two\n\n```\n- [ ] code\n```\n",
    );
  });

  it("offers to start writing when the note is empty", () => {
    const { onStartEditing } = show("---\ntitle: T\n---\n\n");
    fireEvent.click(screen.getByRole("button", { name: /start writing/i }));
    expect(onStartEditing).toHaveBeenCalledTimes(1);
  });
});
