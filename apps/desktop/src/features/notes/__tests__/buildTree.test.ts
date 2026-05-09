import { describe, expect, it } from "vitest";

import type { NoteMeta } from "../../../lib/types";
import { buildTree } from "../buildTree";

function note(relPath: string, title?: string): NoteMeta {
  return {
    path: `/v/${relPath}`,
    relPath,
    title: title ?? relPath.split("/").pop()!.replace(/\.md$/, ""),
    tags: [],
    mtime: 0,
    size: 0,
    pinned: false,
  };
}

describe("buildTree", () => {
  it("returns an empty root for empty input", () => {
    const tree = buildTree([]);
    expect(tree.path).toBe("notes");
    expect(tree.children).toEqual([]);
    expect(tree.files).toEqual([]);
  });

  it("groups files by their parent directory", () => {
    const tree = buildTree([
      note("notes/work/standup.md", "Standup"),
      note("notes/work/plan.md", "Plan"),
      note("notes/personal/idea.md", "Idea"),
    ]);
    expect(tree.children.map((c) => c.name)).toEqual(["personal", "work"]);
    const work = tree.children.find((c) => c.name === "work")!;
    expect(work.files.map((f) => f.title)).toEqual(["Plan", "Standup"]);
  });

  it("nests deeply when paths have multiple segments", () => {
    const tree = buildTree([
      note("notes/a/b/c/deep.md"),
      note("notes/a/b/peer.md"),
    ]);
    const a = tree.children[0]!;
    expect(a.name).toBe("a");
    const b = a.children[0]!;
    expect(b.name).toBe("b");
    expect(b.files.map((f) => f.title)).toEqual(["peer"]);
    const c = b.children[0]!;
    expect(c.name).toBe("c");
    expect(c.files.map((f) => f.title)).toEqual(["deep"]);
  });

  it("places files directly under the root for `notes/<file>.md`", () => {
    const tree = buildTree([note("notes/loose.md", "Loose")]);
    expect(tree.children).toEqual([]);
    expect(tree.files.map((f) => f.title)).toEqual(["Loose"]);
  });

  it("ignores notes that fall outside the root prefix", () => {
    const tree = buildTree([note("journal/2026/05/x.md")]);
    expect(tree.children).toEqual([]);
    expect(tree.files).toEqual([]);
  });
});
