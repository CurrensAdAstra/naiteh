import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CalendarGrid } from "../CalendarGrid";

describe("CalendarGrid", () => {
  it("renders the month label and 42 cells", () => {
    render(
      <CalendarGrid
        month={new Date(2026, 4, 1)}
        today="2026-05-09"
        activeDate={null}
        datesWithContent={new Set()}
        onChangeMonth={vi.fn()}
        onSelectDate={vi.fn()}
      />,
    );
    expect(screen.getByTestId("calendar-grid-label")).toHaveTextContent(
      "May 2026",
    );
    expect(screen.getAllByRole("gridcell")).toHaveLength(42);
  });

  it("marks today with aria-current=date", () => {
    render(
      <CalendarGrid
        month={new Date(2026, 4, 1)}
        today="2026-05-09"
        activeDate={null}
        datesWithContent={new Set()}
        onChangeMonth={vi.fn()}
        onSelectDate={vi.fn()}
      />,
    );
    const todayCell = screen.getByTestId("calendar-grid-cell-2026-05-09");
    expect(todayCell).toHaveAttribute("aria-current", "date");
  });

  it("renders dot indicators only for dates with content", () => {
    const { container } = render(
      <CalendarGrid
        month={new Date(2026, 4, 1)}
        today="2026-05-09"
        activeDate={null}
        datesWithContent={new Set(["2026-05-02", "2026-05-09"])}
        onChangeMonth={vi.fn()}
        onSelectDate={vi.fn()}
      />,
    );
    const cellWithDot = screen.getByTestId("calendar-grid-cell-2026-05-02");
    const cellWithoutDot = screen.getByTestId("calendar-grid-cell-2026-05-03");
    // Dot is a span child with the .dot class.
    expect(cellWithDot.querySelector("span[aria-hidden='true']")).not.toBeNull();
    expect(
      cellWithoutDot.querySelector("span[aria-hidden='true']"),
    ).toBeNull();
    // Sanity check that we picked actual dot-bearing markup.
    expect(container.querySelectorAll("span[aria-hidden='true']").length).toBe(
      2,
    );
  });

  it("clicking a date fires onSelectDate with YYYY-MM-DD", async () => {
    const onSelectDate = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarGrid
        month={new Date(2026, 4, 1)}
        today="2026-05-09"
        activeDate={null}
        datesWithContent={new Set()}
        onChangeMonth={vi.fn()}
        onSelectDate={onSelectDate}
      />,
    );
    await user.click(screen.getByTestId("calendar-grid-cell-2026-05-15"));
    expect(onSelectDate).toHaveBeenCalledWith("2026-05-15");
  });

  it("nav buttons fire onChangeMonth with the adjacent month", async () => {
    const onChangeMonth = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarGrid
        month={new Date(2026, 4, 1)}
        today="2026-05-09"
        activeDate={null}
        datesWithContent={new Set()}
        onChangeMonth={onChangeMonth}
        onSelectDate={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("calendar-grid-prev"));
    expect(onChangeMonth).toHaveBeenLastCalledWith(expect.any(Date));
    expect(onChangeMonth.mock.calls[0]?.[0].getMonth()).toBe(3); // April
    await user.click(screen.getByTestId("calendar-grid-next"));
    expect(onChangeMonth.mock.calls[1]?.[0].getMonth()).toBe(5); // June
  });
});
