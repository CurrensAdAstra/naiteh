import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";

import {
  backupDriveCandidates,
  backupTargetAddDrive,
  backupTargetAddSftp,
  backupTargetConfirmHostKey,
  backupTargetRemove,
  backupTargetUpdate,
  type BackupTarget,
  type SftpAuthMethod,
  type UpdateTargetArgs,
} from "../../lib/api/backup";
import { formatAppError } from "../../lib/types";
import { useVaultStore } from "../../state/vaultStore";
import settings from "../settings/SettingsModal.module.css";
import styles from "./Backup.module.css";
import { driveDestination } from "./backupFormat";

/**
 * Inline add / edit panels for backup targets, shown inside the Backup
 * settings section (not as a second modal, so the settings dialog's
 * focus trap stays the only one). Secret fields are write-only: they are
 * never prefilled; the target only reports whether one is saved.
 */

function Panel({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <div
      className={styles.panel}
      role="dialog"
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <h3 className={styles.panelTitle} id={titleId}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {hint !== undefined && <span className={styles.hint}>{hint}</span>}
    </label>
  );
}

async function pickDirectory(): Promise<string | null> {
  const picked = await openDialog({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}

export function AddDriveDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (target: BackupTarget) => void;
}) {
  const vaultName = useVaultStore((s) => s.active?.name ?? "vault");
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [folder, setFolder] = useState<string>("");
  const [name, setName] = useState("Google Drive");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    backupDriveCandidates()
      .then((list) => {
        if (!live) return;
        setCandidates(list);
        setFolder((f) => (f === "" && list[0] !== undefined ? list[0] : f));
      })
      .catch(() => {
        if (live) setCandidates([]);
      });
    return () => {
      live = false;
    };
  }, []);

  async function browse() {
    try {
      const dir = await pickDirectory();
      if (dir === null) return;
      setCandidates((c) => (c === null || c.includes(dir) ? c : [...c, dir]));
      setFolder(dir);
    } catch (e) {
      setError(formatAppError(e));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (folder === "" || name.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      // Send the exact folder the dialog showed, so the backup lands where
      // the user was told (the backend only auto-appends for bare My Drive).
      onAdded(
        await backupTargetAddDrive(name.trim(), driveDestination(folder, vaultName)),
      );
    } catch (err) {
      setError(formatAppError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Add Google Drive folder" testId="backup-add-drive">
      <p className={styles.hint}>
        Requires <strong>Google Drive for desktop</strong> installed and
        signed in; naiteh copies the vault into a folder Drive already
        syncs, and Drive uploads it.
      </p>
      <form onSubmit={(e) => void submit(e)} className={styles.form}>
        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>Drive folder</legend>
          {candidates === null && (
            <span className={styles.hint}>Looking for Google Drive…</span>
          )}
          {candidates !== null && candidates.length === 0 && (
            <span className={styles.hint} data-testid="backup-drive-none">
              No Google Drive folder found. Choose one with Browse….
            </span>
          )}
          {candidates?.map((c) => (
            <label key={c} className={styles.radioRow}>
              <input
                type="radio"
                name="drive-folder"
                value={c}
                checked={folder === c}
                onChange={() => setFolder(c)}
              />
              <code className={styles.path}>{c}</code>
            </label>
          ))}
          <div>
            <button
              type="button"
              className={settings.button}
              onClick={() => void browse()}
              data-testid="backup-drive-browse"
            >
              Browse…
            </button>
          </div>
        </fieldset>
        <Field label="Name">
          <input
            className={settings.textInput}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-testid="backup-drive-name"
          />
        </Field>
        {folder !== "" && (
          <p className={styles.hint}>
            Backups go to{" "}
            <code className={styles.path} data-testid="backup-drive-dest">
              {driveDestination(folder, vaultName)}
            </code>
          </p>
        )}
        {error !== null && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <div className={settings.actionRow}>
          <button
            type="submit"
            className={`${settings.button} ${settings.buttonPrimary}`}
            disabled={busy || folder === "" || name.trim() === ""}
            data-testid="backup-drive-submit"
          >
            Add
          </button>
          <button type="button" className={settings.button} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Panel>
  );
}

export function AddSftpDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (target: BackupTarget) => void;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authMethod, setAuthMethod] = useState<SftpAuthMethod>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [remoteDir, setRemoteDir] = useState("naiteh-backup");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    target: BackupTarget;
    fingerprint: string;
  } | null>(null);

  const portNum = Number(port);
  const valid =
    host.trim() !== "" &&
    username.trim() !== "" &&
    remoteDir.trim() !== "" &&
    Number.isInteger(portNum) &&
    portNum > 0 &&
    portNum < 65536 &&
    (authMethod === "password" ? password !== "" : keyPath !== "");

  async function browseKey() {
    try {
      const picked = await openDialog({ directory: false, multiple: false });
      if (typeof picked === "string") setKeyPath(picked);
    } catch (e) {
      setError(formatAppError(e));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await backupTargetAddSftp({
        name: name.trim() === "" ? host.trim() : name.trim(),
        host: host.trim(),
        port: portNum,
        username: username.trim(),
        authMethod,
        password: authMethod === "password" ? password : null,
        keyPath: authMethod === "key" ? keyPath : null,
        passphrase: authMethod === "key" && passphrase !== "" ? passphrase : null,
        remoteDir: remoteDir.trim(),
      });
      // Secrets are now stored by the backend; drop them from memory.
      setPassword("");
      setPassphrase("");
      setPending(res);
    } catch (err) {
      setError(formatAppError(err));
    } finally {
      setBusy(false);
    }
  }

  async function trust() {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    try {
      onAdded(
        await backupTargetConfirmHostKey(pending.target.id, pending.fingerprint),
      );
    } catch (err) {
      setError(formatAppError(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancelTrust() {
    if (pending === null) return;
    setBusy(true);
    try {
      await backupTargetRemove(pending.target.id);
    } catch {
      // Nothing was uploaded; a leftover unconfirmed target is harmless.
    } finally {
      setBusy(false);
      onClose();
    }
  }

  if (pending !== null) {
    return (
      <Panel title="Trust this server?" testId="backup-sftp-fingerprint">
        <p className={styles.hint}>
          naiteh trusts a server the first time you connect and afterwards
          refuses to upload if its key ever changes (trust on first use).
          Compare this fingerprint with the one your server administrator
          gives you:
        </p>
        <code className={styles.fingerprint} data-testid="backup-sftp-fp">
          {pending.fingerprint}
        </code>
        {error !== null && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <div className={settings.actionRow}>
          <button
            type="button"
            className={`${settings.button} ${settings.buttonPrimary}`}
            onClick={() => void trust()}
            disabled={busy}
            data-testid="backup-sftp-trust"
          >
            Trust this server
          </button>
          <button
            type="button"
            className={settings.button}
            onClick={() => void cancelTrust()}
            disabled={busy}
            data-testid="backup-sftp-trust-cancel"
          >
            Cancel
          </button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Add SFTP server" testId="backup-add-sftp">
      <form onSubmit={(e) => void submit(e)} className={styles.form}>
        <div className={styles.fieldRow}>
          <Field label="Host">
            <input
              className={settings.textInput}
              value={host}
              onChange={(e) => setHost(e.currentTarget.value)}
              placeholder="nas.example.com"
              data-testid="backup-sftp-host"
            />
          </Field>
          <Field label="Port">
            <input
              className={settings.numberInput}
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.currentTarget.value)}
              data-testid="backup-sftp-port"
            />
          </Field>
        </div>
        <Field label="Username">
          <input
            className={settings.textInput}
            value={username}
            autoComplete="off"
            onChange={(e) => setUsername(e.currentTarget.value)}
            data-testid="backup-sftp-username"
          />
        </Field>
        <fieldset className={styles.fieldset}>
          <legend className={styles.fieldLabel}>Sign in with</legend>
          <label className={styles.radioRow}>
            <input
              type="radio"
              name="sftp-auth"
              checked={authMethod === "password"}
              onChange={() => setAuthMethod("password")}
              data-testid="backup-sftp-auth-password"
            />
            Password
          </label>
          <label className={styles.radioRow}>
            <input
              type="radio"
              name="sftp-auth"
              checked={authMethod === "key"}
              onChange={() => setAuthMethod("key")}
              data-testid="backup-sftp-auth-key"
            />
            Private key
          </label>
        </fieldset>
        {authMethod === "password" ? (
          <Field label="Password">
            <input
              type="password"
              className={settings.textInput}
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.currentTarget.value)}
              data-testid="backup-sftp-password"
            />
          </Field>
        ) : (
          <>
            <Field label="Key file">
              <span className={styles.inline}>
                <code className={styles.path} data-testid="backup-sftp-keypath">
                  {keyPath === "" ? "No file chosen" : keyPath}
                </code>
                <button
                  type="button"
                  className={settings.button}
                  onClick={() => void browseKey()}
                  data-testid="backup-sftp-key-browse"
                >
                  Choose…
                </button>
              </span>
            </Field>
            <Field label="Passphrase (optional)">
              <input
                type="password"
                className={settings.textInput}
                value={passphrase}
                autoComplete="new-password"
                onChange={(e) => setPassphrase(e.currentTarget.value)}
                data-testid="backup-sftp-passphrase"
              />
            </Field>
          </>
        )}
        <Field
          label="Remote folder"
          hint="Relative paths start in your home folder on the server."
        >
          <input
            className={settings.textInput}
            value={remoteDir}
            onChange={(e) => setRemoteDir(e.currentTarget.value)}
            data-testid="backup-sftp-remotedir"
          />
        </Field>
        <Field label="Name">
          <input
            className={settings.textInput}
            value={name}
            placeholder={host === "" ? "My server" : host}
            onChange={(e) => setName(e.currentTarget.value)}
            data-testid="backup-sftp-name"
          />
        </Field>
        {error !== null && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <div className={settings.actionRow}>
          <button
            type="submit"
            className={`${settings.button} ${settings.buttonPrimary}`}
            disabled={busy || !valid}
            data-testid="backup-sftp-submit"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
          <button type="button" className={settings.button} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Panel>
  );
}

export function EditTargetDialog({
  target,
  onClose,
  onSaved,
}: {
  target: BackupTarget;
  onClose: () => void;
  onSaved: (target: BackupTarget) => void;
}) {
  const [name, setName] = useState(target.name);
  const [folder, setFolder] = useState(target.drive?.folder ?? "");
  const [remoteDir, setRemoteDir] = useState(target.sftp?.remoteDir ?? "");
  const [keyPath, setKeyPath] = useState(target.sftp?.keyPath ?? "");
  // Write-only: empty means "keep the saved one".
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sftp = target.sftp;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const args: UpdateTargetArgs = { id: target.id };
    if (name.trim() !== "" && name.trim() !== target.name) args.name = name.trim();
    if (target.kind === "drive" && folder !== (target.drive?.folder ?? "")) {
      args.folder = folder;
    }
    if (sftp !== undefined) {
      if (remoteDir.trim() !== sftp.remoteDir) args.remoteDir = remoteDir.trim();
      if (keyPath !== (sftp.keyPath ?? "")) args.keyPath = keyPath;
      if (password !== "") args.password = password;
      if (passphrase !== "") args.passphrase = passphrase;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await backupTargetUpdate(args);
      setPassword("");
      setPassphrase("");
      onSaved(saved);
    } catch (err) {
      setError(formatAppError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={`Edit ${target.name}`} testId="backup-edit">
      <form onSubmit={(e) => void submit(e)} className={styles.form}>
        <Field label="Name">
          <input
            className={settings.textInput}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-testid="backup-edit-name"
          />
        </Field>
        {target.kind === "drive" && (
          <Field label="Drive folder">
            <span className={styles.inline}>
              <code className={styles.path}>{folder}</code>
              <button
                type="button"
                className={settings.button}
                onClick={() =>
                  void pickDirectory()
                    .then((d) => {
                      if (d !== null) setFolder(d);
                    })
                    .catch((err: unknown) => setError(formatAppError(err)))
                }
              >
                Browse…
              </button>
            </span>
          </Field>
        )}
        {sftp !== undefined && (
          <>
            <Field label="Remote folder">
              <input
                className={settings.textInput}
                value={remoteDir}
                onChange={(e) => setRemoteDir(e.currentTarget.value)}
                data-testid="backup-edit-remotedir"
              />
            </Field>
            {sftp.authMethod === "password" ? (
              <Field
                label="Password"
                hint={
                  sftp.hasPassword
                    ? "Saved. Leave empty to keep it, or type a new one."
                    : "Not saved yet."
                }
              >
                <input
                  type="password"
                  className={settings.textInput}
                  value={password}
                  placeholder={sftp.hasPassword ? "••••••••  (saved)" : ""}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  data-testid="backup-edit-password"
                />
              </Field>
            ) : (
              <>
                <Field label="Key file">
                  <span className={styles.inline}>
                    <code className={styles.path}>{keyPath}</code>
                    <button
                      type="button"
                      className={settings.button}
                      onClick={() =>
                        void openDialog({ directory: false, multiple: false })
                          .then((p) => {
                            if (typeof p === "string") setKeyPath(p);
                          })
                          .catch((err: unknown) => setError(formatAppError(err)))
                      }
                    >
                      Choose…
                    </button>
                  </span>
                </Field>
                <Field
                  label="Passphrase"
                  hint={
                    sftp.hasPassphrase
                      ? "Saved. Leave empty to keep it, or type a new one."
                      : "None saved."
                  }
                >
                  <input
                    type="password"
                    className={settings.textInput}
                    value={passphrase}
                    placeholder={sftp.hasPassphrase ? "••••••••  (saved)" : ""}
                    autoComplete="new-password"
                    onChange={(e) => setPassphrase(e.currentTarget.value)}
                    data-testid="backup-edit-passphrase"
                  />
                </Field>
              </>
            )}
          </>
        )}
        {error !== null && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <div className={settings.actionRow}>
          <button
            type="submit"
            className={`${settings.button} ${settings.buttonPrimary}`}
            disabled={busy}
            data-testid="backup-edit-save"
          >
            Save
          </button>
          <button type="button" className={settings.button} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Panel>
  );
}
