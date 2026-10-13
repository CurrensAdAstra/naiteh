import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const progressHandlers: ((p: unknown) => void)[] = [];

vi.mock("../../../lib/api/backup", () => ({
  backupTargetsList: vi.fn(),
  backupDriveCandidates: vi.fn(),
  backupTargetAddDrive: vi.fn(),
  backupTargetAddSftp: vi.fn(),
  backupTargetConfirmHostKey: vi.fn(),
  backupTargetUpdate: vi.fn(),
  backupTargetRemove: vi.fn(),
  backupTest: vi.fn(),
  backupRun: vi.fn(),
  listenBackupProgress: vi.fn((h: (p: unknown) => void) => {
    progressHandlers.push(h);
    return Promise.resolve(() => {
      const i = progressHandlers.indexOf(h);
      if (i !== -1) progressHandlers.splice(i, 1);
    });
  }),
  listenBackupDone: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  backupDriveCandidates,
  backupRun,
  backupTargetAddDrive,
  backupTargetAddSftp,
  backupTargetConfirmHostKey,
  backupTargetRemove,
  backupTargetsList,
  backupTargetUpdate,
  backupTest,
  type BackupTarget,
} from "../../../lib/api/backup";
import { useBackupStore } from "../../../state/backupStore";
import { useUIStore } from "../../../state/uiStore";
import { useVaultStore } from "../../../state/vaultStore";
import { BackupSection } from "../sections/BackupSection";

const drive: BackupTarget = {
  id: "d1",
  kind: "drive",
  name: "My Drive",
  enabled: true,
  autoBackup: false,
  intervalMinutes: 60,
  lastBackupAt: null,
  lastError: null,
  drive: { folder: "G:\\My Drive" },
};

const sftp: BackupTarget = {
  id: "s1",
  kind: "sftp",
  name: "NAS",
  enabled: true,
  autoBackup: true,
  intervalMinutes: 30,
  lastBackupAt: 1_700_000_000_000,
  lastError: "Network error — timed out",
  sftp: {
    host: "nas.local",
    port: 2222,
    username: "me",
    authMethod: "password",
    keyPath: null,
    hasPassword: true,
    hasPassphrase: false,
    remoteDir: "backups",
    hostKeyFingerprint: "SHA256:abc",
  },
};

function mockList(targets: BackupTarget[]) {
  (backupTargetsList as Mock).mockResolvedValue(targets);
}

describe("BackupSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    progressHandlers.length = 0;
    useBackupStore.setState({
      targets: [],
      loaded: false,
      loadError: null,
      progress: {},
      running: false,
      lastResults: null,
      lastRunError: null,
      compareOpen: false,
    });
    useVaultStore.setState({
      active: { root: "C:\\v\\duramen", name: "duramen", initialized: true },
    });
    useUIStore.setState({ viewMode: "journal", settingsOpen: true });
    mockList([drive, sftp]);
  });

  it("lists targets with location, toggles and last status", async () => {
    render(<BackupSection />);
    const row = await screen.findByTestId("backup-target-s1");
    expect(row).toHaveTextContent("NAS");
    expect(row).toHaveTextContent("me@nas.local:2222:backups");
    expect(row).toHaveTextContent(/Last backup:/);
    expect(row).toHaveTextContent("Last error: Network error — timed out");
    expect(screen.getByTestId("backup-enabled-s1")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("backup-auto-d1")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("backup-interval-d1")).toBeDisabled();
    expect(screen.getByTestId("backup-target-d1")).toHaveTextContent("Never backed up");
  });

  it("shows an empty state when there are no targets", async () => {
    mockList([]);
    render(<BackupSection />);
    expect(await screen.findByTestId("backup-targets-empty")).toBeInTheDocument();
  });

  it("toggles enabled / auto and commits the interval", async () => {
    (backupTargetUpdate as Mock).mockImplementation((a: { id: string }) =>
      Promise.resolve({ ...drive, ...a, intervalMinutes: 15 }),
    );
    render(<BackupSection />);
    fireEvent.click(await screen.findByTestId("backup-enabled-d1"));
    await waitFor(() =>
      expect(backupTargetUpdate).toHaveBeenCalledWith({ id: "d1", enabled: false }),
    );
    fireEvent.click(screen.getByTestId("backup-auto-s1"));
    expect(backupTargetUpdate).toHaveBeenCalledWith({ id: "s1", autoBackup: false });

    const interval = screen.getByTestId("backup-interval-s1");
    fireEvent.change(interval, { target: { value: "15" } });
    fireEvent.blur(interval);
    expect(backupTargetUpdate).toHaveBeenCalledWith({ id: "s1", intervalMinutes: 15 });
  });

  it("removes a target after confirming, saying remote data is kept", async () => {
    (backupTargetRemove as Mock).mockResolvedValue(undefined);
    render(<BackupSection />);
    fireEvent.click(await screen.findByTestId("backup-more-d1"));
    fireEvent.click(screen.getByTestId("backup-remove-d1"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/not deleted/);
    fireEvent.click(screen.getByTestId("backup-remove-confirm-d1"));
    await waitFor(() =>
      expect(screen.queryByTestId("backup-target-d1")).not.toBeInTheDocument(),
    );
    expect(backupTargetRemove).toHaveBeenCalledWith("d1");
  });

  it("tests a connection and reports the result", async () => {
    (backupTest as Mock).mockRejectedValue({ kind: "Network", message: "refused" });
    render(<BackupSection />);
    fireEvent.click(await screen.findByTestId("backup-test-s1"));
    expect(await screen.findByTestId("backup-message-s1")).toHaveTextContent(
      "Network error — refused",
    );
  });

  it("adds a Google Drive folder from the detected candidates", async () => {
    (backupDriveCandidates as Mock).mockResolvedValue(["G:\\My Drive", "H:\\Shared"]);
    (backupTargetAddDrive as Mock).mockResolvedValue({ ...drive, id: "d2", name: "Drive 2" });
    mockList([]);
    render(<BackupSection />);
    fireEvent.click(screen.getByTestId("backup-add-drive-open"));
    const panel = await screen.findByTestId("backup-add-drive");
    expect(panel).toHaveTextContent(/Google Drive for desktop/);
    await waitFor(() =>
      expect(screen.getByTestId("backup-drive-dest")).toHaveTextContent(
        "G:\\My Drive\\naiteh-backup\\duramen",
      ),
    );
    fireEvent.click(within(panel).getByLabelText("H:\\Shared"));
    fireEvent.change(screen.getByTestId("backup-drive-name"), {
      target: { value: "Drive 2" },
    });
    fireEvent.click(screen.getByTestId("backup-drive-submit"));
    await waitFor(() =>
      expect(backupTargetAddDrive).toHaveBeenCalledWith(
        "Drive 2",
        "H:\\Shared\\naiteh-backup\\duramen",
      ),
    );
    expect(await screen.findByTestId("backup-target-d2")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-add-drive")).not.toBeInTheDocument();
  });

  it("adds a Google Drive folder chosen with Browse", async () => {
    (backupDriveCandidates as Mock).mockResolvedValue([]);
    (openDialog as Mock).mockResolvedValue("D:\\Elsewhere");
    (backupTargetAddDrive as Mock).mockResolvedValue({ ...drive, id: "d3" });
    render(<BackupSection />);
    fireEvent.click(screen.getByTestId("backup-add-drive-open"));
    expect(await screen.findByTestId("backup-drive-none")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("backup-drive-browse"));
    await waitFor(() =>
      expect(screen.getByTestId("backup-drive-dest")).toHaveTextContent(
        "D:\\Elsewhere\\naiteh-backup\\duramen",
      ),
    );
    expect(openDialog).toHaveBeenCalledWith({ directory: true, multiple: false });
    fireEvent.click(screen.getByTestId("backup-drive-submit"));
    await waitFor(() =>
      expect(backupTargetAddDrive).toHaveBeenCalledWith(
        "Google Drive",
        "D:\\Elsewhere\\naiteh-backup\\duramen",
      ),
    );
  });

  function fillSftp() {
    fireEvent.click(screen.getByTestId("backup-add-sftp-open"));
    fireEvent.change(screen.getByTestId("backup-sftp-host"), { target: { value: "nas.local" } });
    fireEvent.change(screen.getByTestId("backup-sftp-username"), { target: { value: "me" } });
    fireEvent.change(screen.getByTestId("backup-sftp-password"), { target: { value: "pw" } });
  }

  it("adds an SFTP server and trusts its host key", async () => {
    const pending = { ...sftp, id: "s2", sftp: { ...sftp.sftp!, hostKeyFingerprint: null } };
    (backupTargetAddSftp as Mock).mockResolvedValue({
      target: pending,
      fingerprint: "SHA256:xyz",
    });
    (backupTargetConfirmHostKey as Mock).mockResolvedValue({ ...sftp, id: "s2" });
    render(<BackupSection />);
    await screen.findByTestId("backup-target-s1");
    fillSftp();
    expect(screen.getByTestId("backup-sftp-port")).toHaveValue("22");
    fireEvent.click(screen.getByTestId("backup-sftp-submit"));
    expect(await screen.findByTestId("backup-sftp-fp")).toHaveTextContent("SHA256:xyz");
    expect(screen.getByTestId("backup-sftp-fingerprint")).toHaveTextContent(
      /trust on first use/,
    );
    expect(backupTargetAddSftp).toHaveBeenCalledWith({
      name: "nas.local",
      host: "nas.local",
      port: 22,
      username: "me",
      authMethod: "password",
      password: "pw",
      keyPath: null,
      passphrase: null,
      remoteDir: "naiteh-backup",
    });
    fireEvent.click(screen.getByTestId("backup-sftp-trust"));
    await waitFor(() =>
      expect(backupTargetConfirmHostKey).toHaveBeenCalledWith("s2", "SHA256:xyz"),
    );
    expect(await screen.findByTestId("backup-target-s2")).toBeInTheDocument();
  });

  it("cancelling the fingerprint removes the unconfirmed target", async () => {
    (backupTargetAddSftp as Mock).mockResolvedValue({
      target: { ...sftp, id: "s3" },
      fingerprint: "SHA256:xyz",
    });
    (backupTargetRemove as Mock).mockResolvedValue(undefined);
    render(<BackupSection />);
    fillSftp();
    fireEvent.click(screen.getByTestId("backup-sftp-submit"));
    fireEvent.click(await screen.findByTestId("backup-sftp-trust-cancel"));
    await waitFor(() => expect(backupTargetRemove).toHaveBeenCalledWith("s3"));
    expect(backupTargetConfirmHostKey).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId("backup-sftp-fingerprint")).not.toBeInTheDocument(),
    );
  });

  it("uses a private key file when chosen", async () => {
    (openDialog as Mock).mockResolvedValue("C:\\keys\\id_ed25519");
    (backupTargetAddSftp as Mock).mockResolvedValue({ target: sftp, fingerprint: "f" });
    render(<BackupSection />);
    fireEvent.click(screen.getByTestId("backup-add-sftp-open"));
    fireEvent.change(screen.getByTestId("backup-sftp-host"), { target: { value: "h" } });
    fireEvent.change(screen.getByTestId("backup-sftp-username"), { target: { value: "u" } });
    fireEvent.click(screen.getByTestId("backup-sftp-auth-key"));
    expect(screen.getByTestId("backup-sftp-submit")).toBeDisabled();
    fireEvent.click(screen.getByTestId("backup-sftp-key-browse"));
    await waitFor(() =>
      expect(screen.getByTestId("backup-sftp-keypath")).toHaveTextContent("id_ed25519"),
    );
    fireEvent.change(screen.getByTestId("backup-sftp-passphrase"), { target: { value: "pp" } });
    fireEvent.click(screen.getByTestId("backup-sftp-submit"));
    await waitFor(() =>
      expect(backupTargetAddSftp).toHaveBeenCalledWith(
        expect.objectContaining({
          authMethod: "key",
          password: null,
          keyPath: "C:\\keys\\id_ed25519",
          passphrase: "pp",
        }),
      ),
    );
  });

  it("keeps secrets write-only when editing", async () => {
    (backupTargetUpdate as Mock).mockResolvedValue(sftp);
    render(<BackupSection />);
    fireEvent.click(await screen.findByTestId("backup-more-s1"));
    fireEvent.click(screen.getByTestId("backup-edit-s1"));
    const pw = screen.getByTestId("backup-edit-password");
    expect(pw).toHaveValue("");
    expect(pw).toHaveAttribute("type", "password");
    expect(screen.getByTestId("backup-edit")).toHaveTextContent(/Saved\. Leave empty/);

    // Saving without typing a password never sends one.
    fireEvent.change(screen.getByTestId("backup-edit-name"), { target: { value: "NAS 2" } });
    fireEvent.click(screen.getByTestId("backup-edit-save"));
    await waitFor(() =>
      expect(backupTargetUpdate).toHaveBeenCalledWith({ id: "s1", name: "NAS 2" }),
    );
  });

  it("sends a newly typed password on edit", async () => {
    (backupTargetUpdate as Mock).mockResolvedValue(sftp);
    render(<BackupSection />);
    fireEvent.click(await screen.findByTestId("backup-more-s1"));
    fireEvent.click(screen.getByTestId("backup-edit-s1"));
    fireEvent.change(screen.getByTestId("backup-edit-password"), { target: { value: "new" } });
    fireEvent.click(screen.getByTestId("backup-edit-save"));
    await waitFor(() =>
      expect(backupTargetUpdate).toHaveBeenCalledWith({ id: "s1", password: "new" }),
    );
  });

  it("backs up all targets, shows progress, then the summary", async () => {
    let resolveRun: (v: unknown) => void = () => {};
    (backupRun as Mock).mockReturnValue(new Promise((r) => (resolveRun = r)));
    render(<BackupSection />);
    await screen.findByTestId("backup-target-d1");
    fireEvent.click(screen.getByTestId("backup-run-all"));
    expect(backupRun).toHaveBeenCalledWith(null);
    expect(screen.getByTestId("backup-run-all")).toHaveTextContent("Backing up…");

    await waitFor(() => expect(progressHandlers.length).toBeGreaterThan(0));
    act(() => {
      for (const h of progressHandlers) {
        h({ targetId: "d1", done: 42, total: 120, relPath: "notes/a.md" });
      }
    });
    expect(screen.getByTestId("backup-progress-d1")).toHaveTextContent("42/120");

    await act(async () => {
      resolveRun([
        { targetId: "d1", uploaded: 3, trashed: 1, unchanged: 116, bytes: 9, durationMs: 5, error: null },
        { targetId: "s1", uploaded: 2, trashed: 0, unchanged: 118, bytes: 9, durationMs: 5, error: null },
      ]);
      await Promise.resolve();
    });
    expect(await screen.findByTestId("backup-summary")).toHaveTextContent(
      "5 uploaded, 1 moved to trash, 234 unchanged",
    );
    expect(screen.queryByTestId("backup-progress-d1")).not.toBeInTheDocument();
    expect(screen.getByTestId("backup-result-d1")).toHaveTextContent("3 uploaded");
  });

  it("backs up a single target and surfaces its error", async () => {
    (backupRun as Mock).mockResolvedValue([
      { targetId: "s1", uploaded: 0, trashed: 0, unchanged: 0, bytes: 0, durationMs: 1, error: "auth failed" },
    ]);
    render(<BackupSection />);
    fireEvent.click(await screen.findByTestId("backup-run-s1"));
    expect(backupRun).toHaveBeenCalledWith("s1");
    expect(await screen.findByTestId("backup-run-error")).toHaveTextContent("NAS: auth failed");
    expect(screen.getByTestId("backup-result-s1")).toHaveTextContent("Failed: auth failed");
  });

  it("Compare copies closes settings and opens the compare view", async () => {
    render(<BackupSection />);
    await screen.findByTestId("backup-target-d1");
    fireEvent.click(screen.getByTestId("backup-compare-open"));
    expect(useUIStore.getState().settingsOpen).toBe(false);
    expect(useBackupStore.getState().compareOpen).toBe(true);
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

  it("Open Sync panel switches to Sync and closes settings", () => {
    render(<BackupSection />);
    fireEvent.click(screen.getByTestId("settings-backup-open-sync"));
    expect(useUIStore.getState().viewMode).toBe("sync");
    expect(useUIStore.getState().settingsOpen).toBe(false);
  });
});
