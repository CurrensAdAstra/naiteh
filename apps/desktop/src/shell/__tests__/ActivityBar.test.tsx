import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import {
  JOURNAL_SPLIT_DEFAULT,
  LIST_PANEL_DEFAULT,
  useUIStore,
} from "../../state/uiStore";
import { ActivityBar } from "../ActivityBar";

const EXPECTED_ORDER = [
  "Journal",
  "Notes",
  "Calendar",
  "Search",
  "Tags",
  "Sync",
  "Settings",
];

describe("ActivityBar", () => {
  beforeEach(() => {
    useUIStore.setState({
      viewMode: "journal",
      listPanelWidth: LIST_PANEL_DEFAULT,
      journalSplitRatio: JOURNAL_SPLIT_DEFAULT,
    });
  });

  it("renders the seven ViewMode icons in the documented order", () => {
    render(<ActivityBar />);
    const buttons = screen
      .getByRole("navigation", { name: /activity bar/i })
      .querySelectorAll("button");
    expect(buttons).toHaveLength(7);
    const labels = Array.from(buttons).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(EXPECTED_ORDER);
  });

  it("marks the active mode with aria-current=page", () => {
    render(<ActivityBar />);
    expect(screen.getByRole("button", { name: "Journal" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Notes" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("clicking an icon switches viewMode in the store", async () => {
    const user = userEvent.setup();
    render(<ActivityBar />);
    await user.click(screen.getByRole("button", { name: "Calendar" }));
    expect(useUIStore.getState().viewMode).toBe("calendar");
  });
});
