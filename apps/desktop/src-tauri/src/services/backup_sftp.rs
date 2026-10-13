//! SFTP backup target — a thin [`RemoteFs`] over `ssh2` (libssh2, the same
//! library git2's "ssh" feature links). All logic (manifest, diff, trash,
//! compare) lives in `services::backup` and is tested there against a
//! local directory. See vault/wiki/ipc-api.md ("Backup targets").
//!
//! Host keys are trust-on-first-use: [`handshake`] returns the server's
//! SHA-256 fingerprint, and [`connect`] refuses to authenticate unless it
//! equals the pinned one — no password or key is ever offered to an
//! unconfirmed or changed host.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

use ssh2::{ErrorCode, HashType, RenameFlags, Session, Sftp};

use crate::domain::AppError;
use crate::services::backup::{self, RemoteFile, RemoteFs, StoredSftp, META_DIR};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT_MS: u32 = 60_000;
/// libssh2 SFTP status codes.
const FX_NO_SUCH_FILE: i32 = 2;

fn net(e: impl std::fmt::Display) -> AppError {
    AppError::Network(e.to_string())
}

fn sftp_err(e: ssh2::Error) -> AppError {
    match e.code() {
        ErrorCode::SFTP(FX_NO_SUCH_FILE) => AppError::NotFound(e.message().to_string()),
        ErrorCode::SFTP(_) => AppError::Io(format!("SFTP: {}", e.message())),
        ErrorCode::Session(_) => AppError::Network(e.message().to_string()),
    }
}

/// TCP connect + SSH handshake; returns the session and the server's
/// `SHA256:` host-key fingerprint. Nothing is authenticated yet.
pub fn handshake(host: &str, port: u16) -> Result<(Session, String), AppError> {
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(net)?
        .next()
        .ok_or_else(|| AppError::Network(format!("cannot resolve {host}")))?;
    let tcp = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(net)?;
    let mut sess = Session::new().map_err(net)?;
    sess.set_tcp_stream(tcp);
    sess.set_timeout(IO_TIMEOUT_MS);
    sess.handshake().map_err(net)?;
    let hash = sess
        .host_key_hash(HashType::Sha256)
        .ok_or_else(|| AppError::Network("server sent no host key".into()))?;
    let fingerprint = backup::fingerprint_string(hash);
    Ok((sess, fingerprint))
}

fn authenticate(sess: &Session, cfg: &StoredSftp) -> Result<(), AppError> {
    let unauth = |e: ssh2::Error| AppError::Unauthorized(format!("SSH authentication failed: {e}"));
    match cfg.auth_method.as_str() {
        "password" => sess
            .userauth_password(&cfg.username, cfg.password.as_deref().unwrap_or_default())
            .map_err(unauth)?,
        "key" => {
            let key = cfg
                .key_path
                .as_deref()
                .ok_or_else(|| AppError::Validation("Private key file is required".into()))?;
            sess.userauth_pubkey_file(
                &cfg.username,
                None,
                Path::new(key),
                cfg.passphrase.as_deref().filter(|p| !p.is_empty()),
            )
            .map_err(unauth)?
        }
        other => return Err(AppError::Validation(format!("unknown auth method {other}"))),
    }
    if !sess.authenticated() {
        return Err(AppError::Unauthorized("SSH authentication failed".into()));
    }
    Ok(())
}

pub struct SftpFs {
    sftp: Sftp,
    // Kept alive for the channel; dropped after `sftp`.
    _sess: Session,
    root: String,
}

/// Connect to a configured target: handshake, verify the pinned host key,
/// authenticate, open SFTP and ensure the remote dir exists.
pub fn connect(cfg: &StoredSftp) -> Result<SftpFs, AppError> {
    connect_pinned(cfg, cfg.host_key_fingerprint.as_deref())
}

/// [`connect`] with an explicit pin (used when confirming a fingerprint).
pub fn connect_pinned(cfg: &StoredSftp, pinned: Option<&str>) -> Result<SftpFs, AppError> {
    let (sess, fp) = handshake(&cfg.host, cfg.port)?;
    backup::require_trusted(pinned, &fp)?;
    authenticate(&sess, cfg)?;
    let sftp = sess.sftp().map_err(sftp_err)?;
    let root = if cfg.remote_dir.starts_with('/') {
        cfg.remote_dir.clone()
    } else {
        let home = sftp.realpath(Path::new(".")).map_err(sftp_err)?;
        let home = home.to_string_lossy().replace('\\', "/");
        format!("{}/{}", home.trim_end_matches('/'), cfg.remote_dir)
    };
    let fs = SftpFs {
        sftp,
        _sess: sess,
        root,
    };
    fs.mkdir_p(&fs.root.clone())?;
    Ok(fs)
}

impl SftpFs {
    fn abs(&self, rel: &str) -> Result<String, AppError> {
        Ok(format!("{}/{}", self.root, backup::safe_rel(rel)?))
    }

    fn mkdir_p(&self, dir: &str) -> Result<(), AppError> {
        let mut cur = String::new();
        for (i, part) in dir.split('/').enumerate() {
            if part.is_empty() {
                if i == 0 {
                    cur.push('/');
                }
                continue;
            }
            if !cur.is_empty() && !cur.ends_with('/') {
                cur.push('/');
            }
            cur.push_str(part);
            let p = Path::new(&cur);
            if self.sftp.stat(p).is_err() {
                if let Err(e) = self.sftp.mkdir(p, 0o755) {
                    if self.sftp.stat(p).is_err() {
                        return Err(sftp_err(e));
                    }
                }
            }
        }
        Ok(())
    }

    fn mkdir_parent(&self, abs: &str) -> Result<(), AppError> {
        match abs.rfind('/') {
            Some(i) if i > 0 => self.mkdir_p(&abs[..i]),
            _ => Ok(()),
        }
    }

    /// Rename replacing `to`. OpenSSH (SFTP v3) has no overwrite flag, so
    /// fall back to unlink + rename.
    fn rename_over(&self, from: &str, to: &str) -> Result<(), AppError> {
        let (f, t) = (Path::new(from), Path::new(to));
        let flags = RenameFlags::OVERWRITE | RenameFlags::ATOMIC | RenameFlags::NATIVE;
        if self.sftp.rename(f, t, Some(flags)).is_ok() {
            return Ok(());
        }
        if self.sftp.stat(t).is_ok() {
            self.sftp.unlink(t).map_err(sftp_err)?;
        }
        self.sftp.rename(f, t, None).map_err(sftp_err)
    }

    fn walk(&self, dir: &str, prefix: &str, out: &mut Vec<RemoteFile>) -> Result<(), AppError> {
        for (path, stat) in self.sftp.readdir(Path::new(dir)).map_err(sftp_err)? {
            let Some(name) = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            if name == "." || name == ".." || (prefix.is_empty() && name == META_DIR) {
                continue;
            }
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let child = format!("{dir}/{name}");
            if stat.is_dir() {
                self.walk(&child, &rel, out)?;
            } else if stat.is_file() {
                out.push(RemoteFile {
                    rel,
                    size: stat.size.unwrap_or(0),
                    mtime: stat.mtime.map(|m| m as i64),
                });
            }
        }
        Ok(())
    }
}

impl RemoteFs for SftpFs {
    fn read(&self, rel: &str) -> Result<Option<Vec<u8>>, AppError> {
        let abs = self.abs(rel)?;
        let mut f = match self.sftp.open(Path::new(&abs)) {
            Ok(f) => f,
            Err(e) => {
                return match sftp_err(e) {
                    AppError::NotFound(_) => Ok(None),
                    other => Err(other),
                }
            }
        };
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(net)?;
        Ok(Some(buf))
    }

    fn write_atomic(&self, rel: &str, bytes: &[u8]) -> Result<(), AppError> {
        let abs = self.abs(rel)?;
        self.mkdir_parent(&abs)?;
        let (dir, name) = abs.rsplit_once('/').unwrap_or(("", &abs));
        let tmp = format!(
            "{dir}/.{name}.tmp.{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let written = (|| -> Result<(), AppError> {
            let mut f = self.sftp.create(Path::new(&tmp)).map_err(sftp_err)?;
            f.write_all(bytes).map_err(net)?;
            f.flush().map_err(net)?;
            Ok(())
        })()
        .and_then(|()| self.rename_over(&tmp, &abs));
        if written.is_err() {
            let _ = self.sftp.unlink(Path::new(&tmp));
        }
        written
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), AppError> {
        let (from, to) = (self.abs(from)?, self.abs(to)?);
        self.sftp.stat(Path::new(&from)).map_err(sftp_err)?;
        self.mkdir_parent(&to)?;
        self.rename_over(&from, &to)
    }

    fn remove(&self, rel: &str) -> Result<(), AppError> {
        self.sftp
            .unlink(Path::new(&self.abs(rel)?))
            .map_err(sftp_err)
    }

    fn list_files(&self) -> Result<Vec<RemoteFile>, AppError> {
        let mut out = Vec::new();
        let root = self.root.clone();
        self.walk(&root, "", &mut out)?;
        Ok(out)
    }
}
