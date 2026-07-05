import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/api/vault", () => ({
  vaultCreateDefault: vi.fn(),
  vaultInit: vi.fn(),
  vaultPickFolder: vi.fn(),
  vaultSetActive: vi.fn(),
}));

import { vaultCreateDefault, vaultPickFolder } from "../../../lib/api/vault";
import { useVaultStore } from "../../../state/vaultStore";
import { FirstRunSetup } from "../FirstRunSetup";

const mockedCreateDefault = vi.mocked(vaultCreateDefault);
const mockedPick = vi.mocked(vaultPickFolder);

describe("FirstRunSetup", () => {
  beforeEach(() => {
    mockedCreateDefault.mockReset();
    mockedPick.mockReset();
    useVaultStore.setState({ active: null });
  });

  it("quick-create button provisions heartwood and activates it", async () => {
    const heartwood = {
      root: "/Users/me/Documents/heartwood",
      name: "heartwood",
      initialized: true,
    };
    mockedCreateDefault.mockResolvedValue(heartwood);
    const user = userEvent.setup();

    render(<FirstRunSetup />);
    await user.click(screen.getByTestId("first-run-quick-create"));

    await waitFor(() => {
      expect(mockedCreateDefault).toHaveBeenCalledTimes(1);
      expect(useVaultStore.getState().active).toEqual(heartwood);
    });
    expect(mockedPick).not.toHaveBeenCalled();
  });

  it("surfaces quick-create failures inline", async () => {
    mockedCreateDefault.mockRejectedValue({
      kind: "NotFound",
      message: "no Documents directory on this system",
    });
    const user = userEvent.setup();

    render(<FirstRunSetup />);
    await user.click(screen.getByTestId("first-run-quick-create"));

    expect(
      await screen.findByText(/no Documents directory/i),
    ).toBeInTheDocument();
    expect(useVaultStore.getState().active).toBeNull();
  });
});
