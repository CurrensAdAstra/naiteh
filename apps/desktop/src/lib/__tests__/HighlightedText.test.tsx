import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HighlightedText } from "../HighlightedText";

describe("HighlightedText", () => {
  it("renders the original text when the query is empty", () => {
    const { container } = render(
      <HighlightedText text="hello world" query="" />,
    );
    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(container.textContent).toBe("hello world");
  });

  it("wraps every case-insensitive match in <mark>", () => {
    const { container } = render(
      <HighlightedText
        text="The Quick brown QUICK fox"
        query="quick"
      />,
    );
    const marks = Array.from(container.querySelectorAll("mark"));
    expect(marks).toHaveLength(2);
    // Preserves original casing.
    expect(marks.map((m) => m.textContent)).toEqual(["Quick", "QUICK"]);
    expect(container.textContent).toBe("The Quick brown QUICK fox");
  });

  it("treats whitespace-only queries as empty", () => {
    const { container } = render(
      <HighlightedText text="abc" query="   " />,
    );
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });

  it("does not break when the query is longer than the text", () => {
    render(<HighlightedText text="ab" query="abcdef" />);
    expect(screen.getByText("ab")).toBeInTheDocument();
  });
});
