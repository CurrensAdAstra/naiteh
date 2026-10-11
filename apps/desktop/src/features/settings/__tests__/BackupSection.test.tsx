import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUIStore } from "../../../state/uiStore";
import { useVaultStore } from "../../../state/vaultStore";
import { BackupSection } from "../sections/BackupSection";

const VAULT = "C:\\Users\\me\\Documents\\duramen";

describe("BackupSection", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    useVaultStore.setState({
      active: { root: VAULT, name: "duramen", initialized: true },
    });
    useUIStore.setState({ viewMode: "journal", settingsOpen: true });
  });

  afterEach(() => {
    useVaultStore.setState({ active: null });
  });

  it("recommends Google Drive and shows the vault folder to add", () => {
    render(<BackupSection />);
    expect(screen.getByText("Recommended: Google Drive")).toBeInTheDocument();
    expect(screen.getByTestId("settings-backup-path")).toHaveTextContent(VAULT);
    expect(screen.getByText(/My Computer/)).toBeInTheDocument();
    expect(screen.getByText(/Sync with Google Drive/)).toBeInTheDocument();
  });

  it("explains what is and isn't backed up", () => {
    render(<BackupSection />);
    expect(screen.getByText(/settings, accounts and AI\s+key/i)).toBeInTheDocument();
  });

  it("lists the in-app Sync limits that matter for large attachments", () => {
    render(<BackupSection />);
    const sync = screen.getByTestId("settings-backup-sync");
    expect(sync).toHaveTextContent(/private/i);
    expect(sync).toHaveTextContent(/100 MB/);
  });

  it("copies the vault path", async () => {
    render(<BackupSection />);
    fireEvent.click(screen.getByTestId("settings-backup-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(VAULT));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("tells the user to copy by hand when the clipboard is unavailable", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<BackupSection />);
    fireEvent.click(screen.getByTestId("settings-backup-copy"));
    expect(await screen.findByRole("status")).toHaveTextContent(/copy it\s+manually/i);
  });

  it("asks for a vault when none is open", () => {
    useVaultStore.setState({ active: null });
    render(<BackupSection />);
    expect(screen.queryByTestId("settings-backup-copy")).not.toBeInTheDocument();
    expect(screen.getByText(/No vault is open yet/)).toBeInTheDocument();
  });

  it("Open Sync panel switches to Sync and closes settings", () => {
    render(<BackupSection />);
    fireEvent.click(screen.getByTestId("settings-backup-open-sync"));
    expect(useUIStore.getState().viewMode).toBe("sync");
    expect(useUIStore.getState().settingsOpen).toBe(false);
  });
});
