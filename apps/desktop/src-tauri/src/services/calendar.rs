//! Read-only calendar subscriptions — see vault/wiki/ipc-api.md
//! ("Calendar subscriptions") and vault/wiki/app-config.md
//! (`calendars.json`, `calendar-cache/`).
//!
//! A subscription is an iCal (`.ics`) URL: a Google Calendar "secret
//! address in iCal format", an iCloud public calendar (`webcal://`), or
//! any other public feed. Sources (including their secret URLs) live in
//! the app config dir, never in the vault, so they are not synced or
//! backed up with notes. Each source's last fetched body is cached as
//! `calendar-cache/<id>.ics`.
//!
//! Parsing and recurrence expansion are hand-written (RFC 5545 subset):
//! VEVENT with DTSTART/DTEND/DURATION, RRULE (DAILY/WEEKLY/MONTHLY/
//! YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH),
//! RDATE, EXDATE and RECURRENCE-ID overrides. Unsupported rule parts
//! (BYSETPOS, BYWEEKNO, sub-daily frequencies, …) degrade to the first
//! occurrence only. TZIDs resolve through the IANA database (chrono-tz);
//! an unknown TZID or a floating time is read as local time.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use chrono::{
    DateTime, Datelike, Local, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat,
    TimeDelta, TimeZone, Utc, Weekday,
};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

use crate::domain::AppError;
use crate::services::fs as fsx;

pub const SOURCES_FILE: &str = "calendars.json";
pub const CACHE_DIR: &str = "calendar-cache";
/// A cached feed older than this is refetched by `calendar_events`.
pub const FRESH_SECS: i64 = 10 * 60;
/// Widest `calendar_events` window, in days.
pub const MAX_RANGE_DAYS: i64 = 62;
pub const MAX_DESCRIPTION_CHARS: usize = 2000;
const MAX_FEED_BYTES: usize = 20 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 100;
/// Hard cap on recurrence periods walked per event.
const MAX_PERIODS: u32 = 100_000;

pub const KINDS: &[&str] = &["google", "apple", "ics"];
pub const COLORS: &[&str] = &[
    "orange", "gray", "green", "blue", "purple", "red", "teal", "pink",
];

// ── wire + stored shapes ─────────────────────────────────────────────────

/// What the renderer sees. The full URL is a secret and never leaves
/// the backend; only its host does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub color: String,
    pub enabled: bool,
    pub url_host: String,
    pub last_synced_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub cancelled: bool,
    pub location: Option<String>,
    pub description: Option<String>,
    pub note_rel_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub color: String,
    pub enabled: bool,
    pub url: String,
    #[serde(default)]
    pub last_synced_at: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
    /// Last fetch attempt (success or failure), so a failing feed is
    /// not retried on every `calendar_events` call.
    #[serde(default)]
    pub last_attempt_at: Option<i64>,
}

impl StoredSource {
    pub fn view(&self) -> CalendarSource {
        CalendarSource {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind.clone(),
            color: self.color.clone(),
            enabled: self.enabled,
            url_host: reqwest::Url::parse(&self.url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_default(),
            last_synced_at: self.last_synced_at,
            last_error: self.last_error.clone(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SourcesFile {
    #[serde(default)]
    pub sources: Vec<StoredSource>,
}

// ── store (app config dir) ───────────────────────────────────────────────

/// Serializes read-modify-write cycles on `calendars.json`. Never held
/// across a network await.
static STORE_LOCK: StdMutex<()> = StdMutex::new(());

pub fn sources_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SOURCES_FILE)
}

pub fn cache_path(config_dir: &Path, id: &str) -> PathBuf {
    config_dir.join(CACHE_DIR).join(format!("{id}.ics"))
}

fn read_store(config_dir: &Path) -> Result<SourcesFile, AppError> {
    match fsx::read_json::<SourcesFile>(&sources_path(config_dir)) {
        Ok(f) => Ok(f),
        Err(AppError::NotFound(_)) => Ok(SourcesFile::default()),
        Err(e) => Err(e),
    }
}

pub fn load_sources(config_dir: &Path) -> Result<Vec<StoredSource>, AppError> {
    let _g = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    Ok(read_store(config_dir)?.sources)
}

/// Apply `f` to the stored list under the store lock and persist it.
pub fn modify_sources<T>(
    config_dir: &Path,
    f: impl FnOnce(&mut Vec<StoredSource>) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _g = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = read_store(config_dir)?;
    let out = f(&mut file.sources)?;
    fsx::write_json(&sources_path(config_dir), &file)?;
    Ok(out)
}

pub fn new_source_id() -> Result<String, AppError> {
    let mut buf = [0u8; 8];
    getrandom::getrandom(&mut buf).map_err(|e| AppError::Io(format!("random id: {e}")))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn validate_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Calendar name is required".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(AppError::Validation(
            "Calendar name is too long or invalid".into(),
        ));
    }
    Ok(name.to_string())
}

pub fn validate_color(color: &str) -> Result<(), AppError> {
    if COLORS.contains(&color) {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "Unknown calendar color: {color}"
        )))
    }
}

/// Record a fetch outcome: on success write the cache and stamp
/// `lastSyncedAt`; on failure keep the old cache and set `lastError`.
pub fn record_fetch(
    config_dir: &Path,
    id: &str,
    result: Result<String, AppError>,
    now: i64,
) -> Result<(), AppError> {
    if let Ok(body) = &result {
        fsx::atomic_write(&cache_path(config_dir, id), body.as_bytes())?;
    }
    modify_sources(config_dir, |list| {
        if let Some(s) = list.iter_mut().find(|s| s.id == id) {
            s.last_attempt_at = Some(now);
            match &result {
                Ok(_) => {
                    s.last_synced_at = Some(now);
                    s.last_error = None;
                }
                Err(e) => s.last_error = Some(e.to_string()),
            }
        }
        Ok(())
    })
}

/// True when the source was fetched (or a fetch was attempted) less than
/// [`FRESH_SECS`] ago and a cached body exists.
pub fn is_fresh(source: &StoredSource, has_cache: bool, now: i64) -> bool {
    let recent = |t: Option<i64>| t.is_some_and(|t| t <= now && now - t < FRESH_SECS);
    if has_cache {
        recent(source.last_synced_at) || recent(source.last_attempt_at)
    } else {
        // Never fetched successfully: only back off after a failure.
        recent(source.last_attempt_at) && source.last_error.is_some()
    }
}

pub fn unix_now() -> i64 {
    Utc::now().timestamp()
}

// ── URL rules ────────────────────────────────────────────────────────────

/// Normalize a subscription URL: `webcal://` becomes `https://`, only
/// `https` is accepted, no embedded credentials, and the host must be
/// public (no loopback / private / link-local addresses or local names).
pub fn normalize_url(raw: &str) -> Result<reqwest::Url, AppError> {
    let raw = raw.trim();
    let lower = raw.to_ascii_lowercase();
    let fixed = if lower.starts_with("webcal://") {
        format!("https://{}", &raw["webcal://".len()..])
    } else {
        raw.to_string()
    };
    let url = reqwest::Url::parse(&fixed)
        .map_err(|e| AppError::Validation(format!("Calendar URL is not a valid URL: {e}")))?;
    if url.scheme() != "https" {
        return Err(AppError::Validation(
            "Calendar URL must start with https:// or webcal://".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::Validation(
            "Calendar URL must not contain credentials".into(),
        ));
    }
    if !is_public_url(&url) {
        return Err(AppError::Validation(
            "Calendar URL must point to a public host".into(),
        ));
    }
    Ok(url)
}

pub fn is_public_url(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<IpAddr>() {
        Ok(ip) => is_public_ip(ip),
        Err(_) => is_public_domain(host),
    }
}

fn is_public_domain(d: &str) -> bool {
    let d = d.trim_end_matches('.').to_ascii_lowercase();
    if d.is_empty() || !d.contains('.') {
        return false;
    }
    const LOCAL_SUFFIXES: &[&str] = &[
        ".localhost",
        ".local",
        ".internal",
        ".lan",
        ".home.arpa",
        ".intranet",
    ];
    d != "localhost" && !LOCAL_SUFFIXES.iter().any(|s| d.ends_with(s))
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || o[0] == 0
        || (o[0] == 100 && (64..128).contains(&o[1]))
        || o[0] >= 240)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let seg0 = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg0 & 0xfe00) == 0xfc00
                || (seg0 & 0xffc0) == 0xfe80
                || v6 == Ipv6Addr::LOCALHOST)
        }
    }
}

/// Resolve the stored kind: an explicit `google`/`apple` is kept; `ics`
/// is upgraded from the host.
pub fn detect_kind(kind: &str, url: &reqwest::Url) -> Result<String, AppError> {
    if !KINDS.contains(&kind) {
        return Err(AppError::Validation(format!(
            "Unknown calendar kind: {kind}"
        )));
    }
    if kind != "ics" {
        return Ok(kind.to_string());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    Ok(if host == "calendar.google.com" {
        "google".into()
    } else if host == "icloud.com" || host.ends_with(".icloud.com") {
        "apple".into()
    } else {
        "ics".into()
    })
}

// ── fetching ─────────────────────────────────────────────────────────────

fn http_client() -> Result<reqwest::Client, AppError> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("too many redirects")
        } else if attempt.url().scheme() == "https" && is_public_url(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("redirect to a non-public or non-https URL")
        }
    });
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(45))
        .redirect(policy)
        .user_agent("naiteh-calendar/1")
        .build()
        .map_err(|e| AppError::Network(format!("http client: {e}")))
}

/// True when `text` is an iCalendar stream.
pub fn is_vcalendar(text: &str) -> bool {
    text.trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .is_some_and(|l| l.eq_ignore_ascii_case("BEGIN:VCALENDAR"))
}

/// GET a feed. Network / HTTP failures → `Network`; a body that isn't a
/// VCALENDAR → `Validation("Not an iCal calendar")`. Error messages
/// never include the URL (it is a secret).
pub async fn fetch_ics(url: &str) -> Result<String, AppError> {
    let client = http_client()?;
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Network(describe_reqwest(e)))?;
    if !resp.status().is_success() {
        return Err(AppError::Network(format!(
            "calendar server replied {}",
            resp.status()
        )));
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::Network(describe_reqwest(e)))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_FEED_BYTES {
            return Err(AppError::Network("calendar feed is too large".into()));
        }
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    if !is_vcalendar(&text) {
        return Err(AppError::Validation("Not an iCal calendar".into()));
    }
    Ok(text)
}

fn describe_reqwest(e: reqwest::Error) -> String {
    // Strip the URL: it carries the secret token.
    let e = e.without_url();
    if e.is_timeout() {
        "calendar request timed out".into()
    } else if e.is_connect() {
        "could not connect to the calendar server".into()
    } else if e.is_redirect() {
        "calendar server redirected to a disallowed URL".into()
    } else {
        format!("calendar request failed: {e}")
    }
}

// ── ICS model ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Zone {
    Utc,
    Tz(Tz),
    /// No zone (or an unknown TZID): local wall-clock time.
    Floating,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IcsTime {
    Date(NaiveDate),
    DateTime(NaiveDateTime, Zone),
}

impl IcsTime {
    fn naive(&self) -> NaiveDateTime {
        match self {
            IcsTime::Date(d) => d.and_time(NaiveTime::MIN),
            IcsTime::DateTime(n, _) => *n,
        }
    }

    fn with_naive(&self, n: NaiveDateTime) -> IcsTime {
        match self {
            IcsTime::Date(_) => IcsTime::Date(n.date()),
            IcsTime::DateTime(_, z) => IcsTime::DateTime(n, *z),
        }
    }

    /// Absolute instant (a DATE is local midnight).
    fn instant(&self) -> DateTime<Utc> {
        match self {
            IcsTime::Date(d) => resolve_local(&Local, d.and_time(NaiveTime::MIN)),
            IcsTime::DateTime(n, Zone::Utc) => Utc.from_utc_datetime(n),
            IcsTime::DateTime(n, Zone::Tz(tz)) => resolve_local(tz, *n),
            IcsTime::DateTime(n, Zone::Floating) => resolve_local(&Local, *n),
        }
    }

    /// Instance key used in event ids and to match EXDATE /
    /// RECURRENCE-ID: `YYYYMMDD` for dates, UTC `YYYYMMDDTHHMMSSZ`
    /// otherwise.
    fn key(&self) -> String {
        match self {
            IcsTime::Date(d) => d.format("%Y%m%d").to_string(),
            _ => self.instant().format("%Y%m%dT%H%M%SZ").to_string(),
        }
    }
}

/// Map a wall-clock time in `tz` to UTC: an ambiguous time (fall back)
/// takes the earlier instant, a skipped one (spring forward) is pushed
/// past the gap.
fn resolve_local<T: TimeZone>(tz: &T, n: NaiveDateTime) -> DateTime<Utc> {
    for shift in [0, 1, 2] {
        match tz.from_local_datetime(&(n + TimeDelta::hours(shift))) {
            LocalResult::Single(t) => return t.with_timezone(&Utc),
            LocalResult::Ambiguous(a, _) => return a.with_timezone(&Utc),
            LocalResult::None => continue,
        }
    }
    Utc.from_utc_datetime(&n)
}

#[derive(Debug, Clone, Default)]
pub struct RawEvent {
    pub uid: String,
    pub summary: String,
    pub dtstart: Option<IcsTime>,
    pub dtend: Option<IcsTime>,
    pub duration: Option<TimeDelta>,
    pub rrule: Option<String>,
    pub rdates: Vec<IcsTime>,
    pub exdates: Vec<IcsTime>,
    pub recurrence_id: Option<IcsTime>,
    pub cancelled: bool,
    pub location: Option<String>,
    pub description: Option<String>,
}

struct Prop<'a> {
    name: String,
    params: Vec<(String, String)>,
    value: &'a str,
}

impl Prop<'_> {
    fn param(&self, key: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }
}

/// Undo RFC 5545 line folding (CRLF or LF followed by a space or tab).
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.trim_start_matches('\u{feff}').split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(rest) = line.strip_prefix([' ', '\t']) {
            if let Some(last) = out.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        out.push(line.to_string());
    }
    out
}

fn split_outside_quotes(s: &str, sep: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut in_q = false;
    let mut start = 0;
    for (i, c) in s.char_indices() {
        if c == '"' {
            in_q = !in_q;
        } else if c == sep && !in_q {
            parts.push(&s[start..i]);
            start = i + c.len_utf8();
        }
    }
    parts.push(&s[start..]);
    parts
}

fn parse_prop(line: &str) -> Option<Prop<'_>> {
    let mut in_q = false;
    let colon = line.char_indices().find_map(|(i, c)| {
        if c == '"' {
            in_q = !in_q;
        }
        (c == ':' && !in_q).then_some(i)
    })?;
    let head = &line[..colon];
    let mut parts = split_outside_quotes(head, ';').into_iter();
    let name = parts.next()?.trim().to_ascii_uppercase();
    let params = parts
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((
                k.trim().to_ascii_uppercase(),
                v.trim().trim_matches('"').to_string(),
            ))
        })
        .collect();
    Some(Prop {
        name,
        params,
        value: &line[colon + 1..],
    })
}

fn unescape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n' | 'N') => out.push('\n'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn lookup_tz(tzid: &str) -> Option<Tz> {
    let id = tzid.trim().trim_start_matches('/');
    Tz::from_str(id).ok().or_else(|| {
        // "/mozilla.org/20050126_1/America/New_York"-style prefixes.
        let mut parts: Vec<&str> = id.split('/').collect();
        while parts.len() > 1 {
            parts.remove(0);
            if let Ok(tz) = Tz::from_str(&parts.join("/")) {
                return Some(tz);
            }
        }
        None
    })
}

/// One DATE or DATE-TIME value, honouring `VALUE=DATE` and `TZID`.
fn parse_time_value(value: &str, tzid: Option<&str>, value_type: Option<&str>) -> Option<IcsTime> {
    let v = value.trim();
    let is_date = value_type.is_some_and(|t| t.eq_ignore_ascii_case("DATE")) || v.len() == 8;
    if is_date {
        return NaiveDate::parse_from_str(v.get(..8)?, "%Y%m%d")
            .ok()
            .map(IcsTime::Date);
    }
    let (body, utc) = match v.strip_suffix(['Z', 'z']) {
        Some(b) => (b, true),
        None => (v, false),
    };
    let n = NaiveDateTime::parse_from_str(body, "%Y%m%dT%H%M%S").ok()?;
    let zone = if utc {
        Zone::Utc
    } else {
        match tzid.and_then(lookup_tz) {
            Some(tz) => Zone::Tz(tz),
            None => Zone::Floating,
        }
    };
    Some(IcsTime::DateTime(n, zone))
}

fn parse_time_prop(p: &Prop<'_>) -> Option<IcsTime> {
    parse_time_value(p.value, p.param("TZID"), p.param("VALUE"))
}

fn parse_time_list(p: &Prop<'_>) -> Vec<IcsTime> {
    if p.param("VALUE")
        .is_some_and(|v| v.eq_ignore_ascii_case("PERIOD"))
    {
        return Vec::new();
    }
    p.value
        .split(',')
        .filter_map(|v| parse_time_value(v, p.param("TZID"), p.param("VALUE")))
        .collect()
}

/// RFC 5545 DURATION (`P1D`, `PT1H30M`, `-P2W`, `P1DT2H`).
pub fn parse_duration(s: &str) -> Option<TimeDelta> {
    let s = s.trim();
    let (neg, s) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let s = s.strip_prefix(['P', 'p'])?;
    let mut total = TimeDelta::zero();
    let mut num = String::new();
    for c in s.chars() {
        match c.to_ascii_uppercase() {
            '0'..='9' => num.push(c),
            'T' => {}
            unit @ ('W' | 'D' | 'H' | 'M' | 'S') => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += match unit {
                    'W' => TimeDelta::weeks(n),
                    'D' => TimeDelta::days(n),
                    'H' => TimeDelta::hours(n),
                    'M' => TimeDelta::minutes(n),
                    _ => TimeDelta::seconds(n),
                };
            }
            _ => return None,
        }
    }
    if !num.is_empty() {
        return None;
    }
    Some(if neg { -total } else { total })
}

/// Parse every VEVENT out of an iCalendar stream. Nested components
/// (VALARM) are skipped; VTIMEZONE bodies are ignored (TZIDs resolve
/// through the IANA database).
pub fn parse_ics(text: &str) -> Result<Vec<RawEvent>, AppError> {
    if !is_vcalendar(text) {
        return Err(AppError::Validation("Not an iCal calendar".into()));
    }
    let mut events = Vec::new();
    let mut current: Option<RawEvent> = None;
    let mut nested = 0usize;
    for line in unfold(text) {
        let Some(p) = parse_prop(&line) else { continue };
        let value_upper = p.value.trim().to_ascii_uppercase();
        match p.name.as_str() {
            "BEGIN" if value_upper == "VEVENT" && current.is_none() => {
                current = Some(RawEvent::default());
                nested = 0;
                continue;
            }
            "END" if value_upper == "VEVENT" && nested == 0 => {
                if let Some(ev) = current.take() {
                    if ev.dtstart.is_some() || ev.recurrence_id.is_some() {
                        events.push(ev);
                    }
                }
                continue;
            }
            _ => {}
        }
        let Some(ev) = current.as_mut() else { continue };
        match p.name.as_str() {
            "BEGIN" => nested += 1,
            "END" => nested = nested.saturating_sub(1),
            _ if nested > 0 => {}
            "UID" => ev.uid = p.value.trim().to_string(),
            "SUMMARY" => ev.summary = unescape_text(p.value).trim().to_string(),
            "DTSTART" => ev.dtstart = parse_time_prop(&p),
            "DTEND" => ev.dtend = parse_time_prop(&p),
            "DURATION" => ev.duration = parse_duration(p.value),
            "RRULE" => ev.rrule = Some(p.value.trim().to_string()),
            "RDATE" => ev.rdates.extend(parse_time_list(&p)),
            "EXDATE" => ev.exdates.extend(parse_time_list(&p)),
            "RECURRENCE-ID" => ev.recurrence_id = parse_time_prop(&p),
            "STATUS" => ev.cancelled = value_upper == "CANCELLED",
            "LOCATION" => {
                let v = unescape_text(p.value).trim().to_string();
                ev.location = (!v.is_empty()).then_some(v);
            }
            "DESCRIPTION" => {
                let v = unescape_text(p.value).trim().to_string();
                ev.description =
                    (!v.is_empty()).then(|| v.chars().take(MAX_DESCRIPTION_CHARS).collect());
            }
            _ => {}
        }
    }
    Ok(events)
}

// ── RRULE ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone)]
struct Rule {
    freq: Freq,
    interval: u32,
    count: Option<u32>,
    until: Option<IcsTime>,
    byday: Vec<(Option<i32>, Weekday)>,
    bymonthday: Vec<i32>,
    bymonth: Vec<u32>,
}

fn parse_weekday(s: &str) -> Option<Weekday> {
    Some(match s {
        "MO" => Weekday::Mon,
        "TU" => Weekday::Tue,
        "WE" => Weekday::Wed,
        "TH" => Weekday::Thu,
        "FR" => Weekday::Fri,
        "SA" => Weekday::Sat,
        "SU" => Weekday::Sun,
        _ => return None,
    })
}

/// `None` = unsupported rule (the caller falls back to DTSTART only).
fn parse_rule(s: &str, dtstart: &IcsTime) -> Option<Rule> {
    let mut rule = Rule {
        freq: Freq::Daily,
        interval: 1,
        count: None,
        until: None,
        byday: Vec::new(),
        bymonthday: Vec::new(),
        bymonth: Vec::new(),
    };
    let mut freq_seen = false;
    for part in s.split(';').filter(|p| !p.is_empty()) {
        let (k, v) = part.split_once('=')?;
        let v = v.trim().to_ascii_uppercase();
        match k.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq_seen = true;
                rule.freq = match v.as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                }
            }
            "INTERVAL" => rule.interval = v.parse().ok().filter(|n| *n > 0)?,
            "COUNT" => rule.count = Some(v.parse().ok()?),
            "UNTIL" => {
                let tzid = match dtstart {
                    IcsTime::DateTime(_, Zone::Tz(tz)) => Some(tz.name()),
                    _ => None,
                };
                rule.until = Some(parse_time_value(&v, tzid, None)?);
            }
            "BYDAY" => {
                for d in v.split(',') {
                    let d = d.trim();
                    let split = d.len().checked_sub(2)?;
                    let wd = parse_weekday(d.get(split..)?)?;
                    let ord = &d[..split];
                    let ord = if ord.is_empty() {
                        None
                    } else {
                        Some(ord.trim_start_matches('+').parse::<i32>().ok()?)
                    };
                    rule.byday.push((ord, wd));
                }
            }
            "BYMONTHDAY" => {
                for d in v.split(',') {
                    rule.bymonthday.push(d.trim().parse().ok()?);
                }
            }
            "BYMONTH" => {
                for d in v.split(',') {
                    rule.bymonth.push(d.trim().parse().ok()?);
                }
            }
            "WKST" => {}
            _ => return None,
        }
    }
    if !freq_seen {
        return None;
    }
    if rule.freq == Freq::Yearly && !rule.byday.is_empty() && rule.bymonth.is_empty() {
        return None;
    }
    Some(rule)
}

fn days_in_month(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map_or(28, |d| d.day())
}

fn month_days(y: i32, m: u32, rule: &Rule, default_day: u32) -> Vec<NaiveDate> {
    let dim = days_in_month(y, m) as i32;
    let mut out = Vec::new();
    if !rule.bymonthday.is_empty() {
        for &md in &rule.bymonthday {
            let day = if md < 0 { dim + md + 1 } else { md };
            if (1..=dim).contains(&day) {
                if let Some(d) = NaiveDate::from_ymd_opt(y, m, day as u32) {
                    if rule.byday.is_empty() || rule.byday.iter().any(|(_, w)| *w == d.weekday()) {
                        out.push(d);
                    }
                }
            }
        }
    } else if !rule.byday.is_empty() {
        for &(ord, wd) in &rule.byday {
            let all: Vec<NaiveDate> = (1..=dim as u32)
                .filter_map(|day| NaiveDate::from_ymd_opt(y, m, day))
                .filter(|d| d.weekday() == wd)
                .collect();
            match ord {
                None => out.extend(all),
                Some(n) if n > 0 => out.extend(all.get(n as usize - 1)),
                Some(n) if n < 0 => out.extend(
                    all.len()
                        .checked_sub(n.unsigned_abs() as usize)
                        .map(|i| all[i]),
                ),
                _ => {}
            }
        }
    } else if let Some(d) = NaiveDate::from_ymd_opt(y, m, default_day) {
        out.push(d);
    }
    out
}

fn add_months(y: i32, m: u32, k: i64) -> (i32, u32) {
    let idx = y as i64 * 12 + (m as i64 - 1) + k;
    ((idx.div_euclid(12)) as i32, (idx.rem_euclid(12) + 1) as u32)
}

/// Occurrence starts (wall-clock in DTSTART's zone) from DTSTART up to
/// `horizon` (inclusive date), honouring COUNT / UNTIL.
fn expand_rule(rule: &Rule, dtstart: &IcsTime, horizon: NaiveDate) -> Vec<IcsTime> {
    let start = dtstart.naive();
    let d0 = start.date();
    let time = start.time();
    let past_until = |t: &IcsTime| match (rule.until, t) {
        (None, _) => false,
        (Some(IcsTime::Date(u)), t) => t.naive().date() > u,
        (Some(u), IcsTime::Date(d)) => *d > u.naive().date(),
        (Some(u), t) => t.instant() > u.instant(),
    };
    let mut out = Vec::new();
    let mut count = 0u32;
    let interval = rule.interval as i64;
    for k in 0..MAX_PERIODS as i64 {
        let (period_start, mut cands): (NaiveDate, Vec<NaiveDate>) = match rule.freq {
            Freq::Daily => {
                let Some(d) = d0.checked_add_signed(TimeDelta::days(k * interval)) else {
                    break;
                };
                let ok = (rule.bymonth.is_empty() || rule.bymonth.contains(&d.month()))
                    && (rule.byday.is_empty() || rule.byday.iter().any(|(_, w)| *w == d.weekday()))
                    && (rule.bymonthday.is_empty()
                        || month_days(d.year(), d.month(), rule, d.day()).contains(&d));
                (d, if ok { vec![d] } else { vec![] })
            }
            Freq::Weekly => {
                let wk0 = d0 - TimeDelta::days(d0.weekday().num_days_from_monday() as i64);
                let Some(ws) = wk0.checked_add_signed(TimeDelta::weeks(k * interval)) else {
                    break;
                };
                let days: Vec<Weekday> = if rule.byday.is_empty() {
                    vec![d0.weekday()]
                } else {
                    rule.byday.iter().map(|(_, w)| *w).collect()
                };
                let c = days
                    .into_iter()
                    .map(|w| ws + TimeDelta::days(w.num_days_from_monday() as i64))
                    .filter(|d| rule.bymonth.is_empty() || rule.bymonth.contains(&d.month()))
                    .collect();
                (ws, c)
            }
            Freq::Monthly => {
                let (y, m) = add_months(d0.year(), d0.month(), k * interval);
                let Some(first) = NaiveDate::from_ymd_opt(y, m, 1) else {
                    break;
                };
                let c = if rule.bymonth.is_empty() || rule.bymonth.contains(&m) {
                    month_days(y, m, rule, d0.day())
                } else {
                    vec![]
                };
                (first, c)
            }
            Freq::Yearly => {
                let y = d0.year() + (k * interval) as i32;
                let Some(first) = NaiveDate::from_ymd_opt(y, 1, 1) else {
                    break;
                };
                let months = if rule.bymonth.is_empty() {
                    vec![d0.month()]
                } else {
                    rule.bymonth.clone()
                };
                let c = months
                    .into_iter()
                    .filter(|m| (1..=12).contains(m))
                    .flat_map(|m| month_days(y, m, rule, d0.day()))
                    .collect();
                (first, c)
            }
        };
        if period_start > horizon {
            break;
        }
        cands.sort();
        cands.dedup();
        for d in cands {
            let n = d.and_time(time);
            if n < start {
                continue;
            }
            let t = dtstart.with_naive(n);
            if past_until(&t) {
                return out;
            }
            if d > horizon {
                return out;
            }
            out.push(t);
            count += 1;
            if rule.count.is_some_and(|c| count >= c) {
                return out;
            }
        }
    }
    out
}

// ── expansion into wire events ───────────────────────────────────────────

/// The requested window: dates are local calendar days, `end` exclusive.
#[derive(Debug, Clone, Copy)]
pub struct Range {
    pub start: NaiveDate,
    pub end: NaiveDate,
}

impl Range {
    pub fn parse(start: &str, end: &str) -> Result<Range, AppError> {
        let p = |s: &str| {
            NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
                .map_err(|_| AppError::Validation(format!("Invalid date (want YYYY-MM-DD): {s}")))
        };
        let (start, end) = (p(start)?, p(end)?);
        let span = (end - start).num_days();
        if span <= 0 {
            return Err(AppError::Validation("end must be after start".into()));
        }
        if span > MAX_RANGE_DAYS {
            return Err(AppError::Validation(format!(
                "date range is limited to {MAX_RANGE_DAYS} days"
            )));
        }
        Ok(Range { start, end })
    }

    fn start_instant(&self) -> DateTime<Utc> {
        IcsTime::Date(self.start).instant()
    }

    fn end_instant(&self) -> DateTime<Utc> {
        IcsTime::Date(self.end).instant()
    }
}

struct Instance<'a> {
    ev: &'a RawEvent,
    start: IcsTime,
    key: String,
}

/// Event length: from DTEND, else DURATION, else 1 day (all-day) / 0.
fn event_length(ev: &RawEvent, start: &IcsTime) -> TimeDelta {
    match (start, ev.dtend) {
        (IcsTime::Date(s), Some(IcsTime::Date(e))) => e - *s,
        (IcsTime::Date(_), _) => ev.duration.unwrap_or(TimeDelta::days(1)),
        (_, Some(end)) => end.instant() - start.instant(),
        _ => ev.duration.unwrap_or_else(TimeDelta::zero),
    }
}

fn fmt_instant(t: DateTime<Utc>) -> String {
    t.with_timezone(&Local)
        .to_rfc3339_opts(SecondsFormat::Secs, false)
}

/// Expand parsed events into the instances overlapping `range`, sorted
/// by start. `note_for` maps an event id to an existing note.
pub fn expand_events(
    calendar_id: &str,
    events: &[RawEvent],
    range: Range,
    note_for: &dyn Fn(&str) -> Option<String>,
) -> Vec<CalendarEvent> {
    let horizon = range.end + TimeDelta::days(2);
    let overrides: HashSet<(String, String)> = events
        .iter()
        .filter_map(|e| e.recurrence_id.map(|r| (e.uid.clone(), r.key())))
        .collect();
    let mut instances: Vec<Instance<'_>> = Vec::new();
    for ev in events {
        if let Some(rid) = ev.recurrence_id {
            let start = ev.dtstart.unwrap_or(rid);
            instances.push(Instance {
                ev,
                start,
                key: rid.key(),
            });
            continue;
        }
        let Some(dtstart) = ev.dtstart else { continue };
        let mut starts: Vec<IcsTime> =
            match ev.rrule.as_deref().and_then(|r| parse_rule(r, &dtstart)) {
                Some(rule) => expand_rule(&rule, &dtstart, horizon),
                None => vec![dtstart],
            };
        starts.extend(ev.rdates.iter().copied());
        let ex: HashSet<String> = ev.exdates.iter().map(IcsTime::key).collect();
        let mut seen = HashSet::new();
        for s in starts {
            let key = s.key();
            if ex.contains(&key)
                || overrides.contains(&(ev.uid.clone(), key.clone()))
                || !seen.insert(key.clone())
            {
                continue;
            }
            instances.push(Instance { ev, start: s, key });
        }
    }

    let (rs, re) = (range.start_instant(), range.end_instant());
    let mut out: Vec<(i64, CalendarEvent)> = Vec::new();
    for inst in instances {
        let len = event_length(inst.ev, &inst.start);
        let (start_s, end_s, all_day, sort_key, overlaps) = match inst.start {
            IcsTime::Date(d) => {
                let days = len.num_days().max(1);
                let end = d + TimeDelta::days(days);
                let overlaps = d < range.end && end > range.start;
                (
                    d.format("%Y-%m-%d").to_string(),
                    end.format("%Y-%m-%d").to_string(),
                    true,
                    inst.start.instant().timestamp(),
                    overlaps,
                )
            }
            _ => {
                let s = inst.start.instant();
                let e = s + len.max(TimeDelta::zero());
                let overlaps = if e > s {
                    s < re && e > rs
                } else {
                    s >= rs && s < re
                };
                (
                    fmt_instant(s),
                    fmt_instant(e),
                    false,
                    s.timestamp(),
                    overlaps,
                )
            }
        };
        if !overlaps {
            continue;
        }
        let id = format!("{}@{}", inst.ev.uid, inst.key);
        let title = if inst.ev.summary.is_empty() {
            "(untitled)".to_string()
        } else {
            inst.ev.summary.clone()
        };
        out.push((
            sort_key,
            CalendarEvent {
                note_rel_path: note_for(&id),
                id,
                calendar_id: calendar_id.to_string(),
                title,
                start: start_s,
                end: end_s,
                all_day,
                cancelled: inst.ev.cancelled,
                location: inst.ev.location.clone(),
                description: inst.ev.description.clone(),
            },
        ));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.title.cmp(&b.1.title)));
    out.into_iter().map(|(_, e)| e).collect()
}

/// Read every enabled source's cache and expand it into `range`.
/// Unparseable caches are skipped.
pub fn events_from_cache(
    config_dir: &Path,
    sources: &[StoredSource],
    range: Range,
    note_for: &dyn Fn(&str) -> Option<String>,
) -> Vec<CalendarEvent> {
    let mut all: Vec<CalendarEvent> = Vec::new();
    for s in sources.iter().filter(|s| s.enabled) {
        let Ok(text) = std::fs::read_to_string(cache_path(config_dir, &s.id)) else {
            continue;
        };
        let Ok(events) = parse_ics(&text) else {
            continue;
        };
        all.extend(expand_events(&s.id, &events, range, note_for));
    }
    let key = |e: &CalendarEvent| -> i64 {
        if e.all_day {
            NaiveDate::parse_from_str(&e.start, "%Y-%m-%d")
                .map(|d| IcsTime::Date(d).instant().timestamp())
                .unwrap_or(0)
        } else {
            DateTime::parse_from_rfc3339(&e.start)
                .map(|d| d.timestamp())
                .unwrap_or(0)
        }
    };
    all.sort_by_key(key);
    all
}

/// Event-id → note rel path, from an index snapshot.
pub fn note_lookup(snap: &crate::services::index::TagSnapshot) -> HashMap<String, String> {
    snap.notes
        .iter()
        .filter_map(|d| d.event_id.clone().map(|id| (id, d.meta.rel_path.clone())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn cal(body: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{body}END:VCALENDAR\r\n")
    }

    fn range(a: &str, b: &str) -> Range {
        Range::parse(a, b).unwrap()
    }

    fn expand(text: &str, r: Range) -> Vec<CalendarEvent> {
        expand_events("c1", &parse_ics(text).unwrap(), r, &|_| None)
    }

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn parses_timed_utc_event_with_folding_and_escapes() {
        let text = cal(
            "BEGIN:VEVENT\r\nUID:a1\r\nSUMMARY:Stand\r\n up\\, daily\r\nDTSTART:20260105T090000Z\r\n\
             DTEND:20260105T093000Z\r\nLOCATION:Room 1\r\nDESCRIPTION:line1\\nline2\r\n\
             BEGIN:VALARM\r\nDESCRIPTION:alarm\r\nEND:VALARM\r\nEND:VEVENT\r\n",
        );
        let evs = expand(&text, range("2026-01-01", "2026-01-31"));
        assert_eq!(evs.len(), 1);
        let e = &evs[0];
        assert_eq!(e.title, "Standup, daily");
        assert!(!e.all_day);
        assert_eq!(utc(&e.start), utc("2026-01-05T09:00:00Z"));
        assert_eq!(utc(&e.end), utc("2026-01-05T09:30:00Z"));
        assert_eq!(e.location.as_deref(), Some("Room 1"));
        assert_eq!(e.description.as_deref(), Some("line1\nline2"));
        assert_eq!(e.id, "a1@20260105T090000Z");
        assert!(!e.cancelled);
    }

    #[test]
    fn parses_all_day_event_with_exclusive_end() {
        let text = cal(
            "BEGIN:VEVENT\nUID:d\nSUMMARY:Trip\nDTSTART;VALUE=DATE:20260110\nDTEND;VALUE=DATE:20260113\nEND:VEVENT\n",
        );
        let evs = expand(&text, range("2026-01-12", "2026-01-13"));
        assert_eq!(evs.len(), 1);
        assert!(evs[0].all_day);
        assert_eq!(evs[0].start, "2026-01-10");
        assert_eq!(evs[0].end, "2026-01-13");
        // Exclusive end: not in a window starting on the end date.
        assert!(expand(&text, range("2026-01-13", "2026-01-14")).is_empty());
        // No DTEND → one day.
        let one = cal("BEGIN:VEVENT\nUID:o\nDTSTART;VALUE=DATE:20260110\nEND:VEVENT\n");
        assert_eq!(
            expand(&one, range("2026-01-10", "2026-01-11"))[0].end,
            "2026-01-11"
        );
    }

    #[test]
    fn tzid_resolves_through_iana_database() {
        let text = cal(
            "BEGIN:VEVENT\nUID:t\nDTSTART;TZID=America/New_York:20260706T090000\n\
             DTEND;TZID=America/New_York:20260706T100000\nEND:VEVENT\n",
        );
        let e = &expand(&text, range("2026-07-01", "2026-07-31"))[0];
        // EDT is UTC-4.
        assert_eq!(utc(&e.start), utc("2026-07-06T13:00:00Z"));
        assert_eq!(utc(&e.end), utc("2026-07-06T14:00:00Z"));
        // Prefixed TZID spellings resolve too.
        assert!(matches!(
            parse_time_value(
                "20260101T000000",
                Some("/mozilla.org/x/Europe/Berlin"),
                None
            ),
            Some(IcsTime::DateTime(_, Zone::Tz(chrono_tz::Europe::Berlin)))
        ));
    }

    #[test]
    fn floating_and_unknown_tzid_are_local_time() {
        let text = cal(
            "BEGIN:VEVENT\nUID:f\nDTSTART:20260310T083000\nDURATION:PT45M\nEND:VEVENT\n\
             BEGIN:VEVENT\nUID:g\nDTSTART;TZID=Nowhere Standard Time:20260310T120000\nEND:VEVENT\n",
        );
        let evs = expand(&text, range("2026-03-01", "2026-03-31"));
        assert_eq!(evs.len(), 2);
        let s = DateTime::parse_from_rfc3339(&evs[0].start).unwrap();
        assert_eq!(
            s.with_timezone(&Local).naive_local().to_string(),
            "2026-03-10 08:30:00"
        );
        let e = DateTime::parse_from_rfc3339(&evs[0].end).unwrap();
        assert_eq!((e - s).num_minutes(), 45);
        let g = DateTime::parse_from_rfc3339(&evs[1].start).unwrap();
        assert_eq!(
            g.with_timezone(&Local).naive_local().to_string(),
            "2026-03-10 12:00:00"
        );
    }

    #[test]
    fn cancelled_status_is_flagged() {
        let text =
            cal("BEGIN:VEVENT\nUID:x\nSTATUS:CANCELLED\nDTSTART:20260105T090000Z\nEND:VEVENT\n");
        assert!(expand(&text, range("2026-01-01", "2026-01-31"))[0].cancelled);
    }

    #[test]
    fn rejects_non_calendar_text() {
        assert!(matches!(parse_ics("<html>"), Err(AppError::Validation(_))));
        assert!(is_vcalendar("\u{feff}\r\nBEGIN:VCALENDAR\r\n"));
        assert!(!is_vcalendar("BEGIN:VCARD"));
    }

    #[test]
    fn daily_rrule_with_count_and_exdate() {
        let text = cal(
            "BEGIN:VEVENT\nUID:r\nSUMMARY:Daily\nDTSTART:20260101T100000Z\nDTEND:20260101T103000Z\n\
             RRULE:FREQ=DAILY;COUNT=5\nEXDATE:20260103T100000Z\nEND:VEVENT\n",
        );
        let evs = expand(&text, range("2026-01-01", "2026-02-01"));
        let days: Vec<_> = evs
            .iter()
            .map(|e| utc(&e.start).format("%d").to_string())
            .collect();
        assert_eq!(days, vec!["01", "02", "04", "05"]);
    }

    #[test]
    fn weekly_rrule_byday_until_and_interval() {
        // 2026-01-05 is a Monday. Every 2 weeks Mon+Wed until Feb 1.
        let text = cal(
            "BEGIN:VEVENT\nUID:w\nDTSTART;TZID=Europe/Berlin:20260105T090000\n\
             RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20260201T000000Z\nEND:VEVENT\n",
        );
        let evs = expand(&text, range("2026-01-01", "2026-03-01"));
        let days: Vec<_> = evs
            .iter()
            .map(|e| utc(&e.start).format("%m-%d %H:%M").to_string())
            .collect();
        assert_eq!(
            days,
            vec!["01-05 08:00", "01-07 08:00", "01-19 08:00", "01-21 08:00"]
        );
    }

    #[test]
    fn monthly_and_yearly_rules() {
        let text = cal(
            "BEGIN:VEVENT\nUID:m\nDTSTART;VALUE=DATE:20260101\nRRULE:FREQ=MONTHLY;BYDAY=-1FR\nEND:VEVENT\n\
             BEGIN:VEVENT\nUID:y\nDTSTART;VALUE=DATE:20200229\nRRULE:FREQ=YEARLY\nEND:VEVENT\n",
        );
        let evs = expand(&text, range("2026-01-01", "2026-03-01"));
        let starts: Vec<_> = evs.iter().map(|e| e.start.as_str()).collect();
        // Last Fridays; the Feb 29 birthday has no 2026 occurrence.
        assert_eq!(starts, vec!["2026-01-30", "2026-02-27"]);
    }

    #[test]
    fn recurrence_id_override_replaces_instance() {
        let text = cal(
            "BEGIN:VEVENT\nUID:o\nSUMMARY:Sync\nDTSTART:20260105T090000Z\nRRULE:FREQ=WEEKLY;COUNT=3\nEND:VEVENT\n\
             BEGIN:VEVENT\nUID:o\nSUMMARY:Sync (moved)\nRECURRENCE-ID:20260112T090000Z\n\
             DTSTART:20260113T150000Z\nDTEND:20260113T160000Z\nEND:VEVENT\n\
             BEGIN:VEVENT\nUID:o\nSUMMARY:Sync\nRECURRENCE-ID:20260119T090000Z\n\
             DTSTART:20260119T090000Z\nSTATUS:CANCELLED\nEND:VEVENT\n",
        );
        let evs = expand(&text, range("2026-01-01", "2026-02-01"));
        assert_eq!(evs.len(), 3);
        assert_eq!(evs[1].title, "Sync (moved)");
        assert_eq!(utc(&evs[1].start), utc("2026-01-13T15:00:00Z"));
        // Stable id: keyed by the original instance start.
        assert_eq!(evs[1].id, "o@20260112T090000Z");
        assert!(evs[2].cancelled);
        assert!(!evs[0].cancelled);
    }

    #[test]
    fn rdate_adds_instances_and_unsupported_rules_fall_back() {
        let text = cal(
            "BEGIN:VEVENT\nUID:rd\nDTSTART:20260105T090000Z\nRDATE:20260110T090000Z,20260120T090000Z\nEND:VEVENT\n\
             BEGIN:VEVENT\nUID:u\nDTSTART:20260106T090000Z\nRRULE:FREQ=HOURLY\nEND:VEVENT\n",
        );
        let evs = expand(&text, range("2026-01-01", "2026-02-01"));
        assert_eq!(evs.iter().filter(|e| e.id.starts_with("rd@")).count(), 3);
        assert_eq!(evs.iter().filter(|e| e.id.starts_with("u@")).count(), 1);
    }

    #[test]
    fn range_filtering_and_validation() {
        let text = cal(
            "BEGIN:VEVENT\nUID:a\nDTSTART:20260105T120000Z\nEND:VEVENT\n\
             BEGIN:VEVENT\nUID:b\nDTSTART:20260305T120000Z\nEND:VEVENT\n\
             BEGIN:VEVENT\nUID:c\nDTSTART:20251220T120000Z\nRRULE:FREQ=DAILY\nEND:VEVENT\n",
        );
        let evs = expand(&text, range("2026-01-04", "2026-01-07"));
        assert!(evs.iter().any(|e| e.id.starts_with("a@")));
        assert!(!evs.iter().any(|e| e.id.starts_with("b@")));
        // Infinite daily rule yields only in-range days (±tz edge).
        let c = evs.iter().filter(|e| e.id.starts_with("c@")).count();
        assert!((2..=4).contains(&c), "{c}");
        // Sorted by start.
        let starts: Vec<_> = evs.iter().map(|e| utc(&e.start)).collect();
        assert!(starts.windows(2).all(|w| w[0] <= w[1]));
        assert!(Range::parse("2026-01-01", "2026-03-05").is_err());
        assert!(Range::parse("2026-01-02", "2026-01-01").is_err());
        assert!(Range::parse("2026/01/01", "2026-01-02").is_err());
        assert!(Range::parse("2026-01-01", "2026-03-04").is_ok());
    }

    #[test]
    fn description_is_truncated() {
        let long = "x".repeat(3000);
        let text = cal(&format!(
            "BEGIN:VEVENT\nUID:l\nDTSTART:20260105T120000Z\nDESCRIPTION:{long}\nEND:VEVENT\n"
        ));
        let e = &expand(&text, range("2026-01-01", "2026-01-31"))[0];
        assert_eq!(
            e.description.as_ref().unwrap().chars().count(),
            MAX_DESCRIPTION_CHARS
        );
    }

    #[test]
    fn duration_parsing() {
        assert_eq!(parse_duration("PT1H30M"), Some(TimeDelta::minutes(90)));
        assert_eq!(parse_duration("P1W"), Some(TimeDelta::days(7)));
        assert_eq!(parse_duration("-P1DT2H"), Some(-TimeDelta::hours(26)));
        assert_eq!(parse_duration("1H"), None);
    }

    #[test]
    fn url_rules_webcal_and_public_hosts() {
        let u = normalize_url("webcal://p01-caldav.icloud.com/published/2/abc").unwrap();
        assert_eq!(u.scheme(), "https");
        assert_eq!(u.host_str(), Some("p01-caldav.icloud.com"));
        assert!(normalize_url("WEBCAL://calendar.google.com/x.ics").is_ok());
        for bad in [
            "http://calendar.google.com/x.ics",
            "ftp://example.com/x.ics",
            "https://localhost/x.ics",
            "https://127.0.0.1/x.ics",
            "https://10.0.0.5/x.ics",
            "https://192.168.1.2/x.ics",
            "https://169.254.169.254/latest",
            "https://[::1]/x.ics",
            "https://[fd00::1]/x.ics",
            "https://printer.local/x.ics",
            "https://intranet/x.ics",
            "https://user:pw@example.com/x.ics",
            "not a url",
        ] {
            assert!(
                matches!(normalize_url(bad), Err(AppError::Validation(_))),
                "{bad} accepted"
            );
        }
        assert!(normalize_url("https://8.8.8.8/x.ics").is_ok());
    }

    #[test]
    fn kind_detection() {
        let g = normalize_url("https://calendar.google.com/calendar/ical/x/private-y/basic.ics")
            .unwrap();
        let a = normalize_url("webcal://p42-caldav.icloud.com/published/2/z").unwrap();
        let o = normalize_url("https://example.com/cal.ics").unwrap();
        assert_eq!(detect_kind("ics", &g).unwrap(), "google");
        assert_eq!(detect_kind("ics", &a).unwrap(), "apple");
        assert_eq!(detect_kind("ics", &o).unwrap(), "ics");
        assert_eq!(detect_kind("apple", &o).unwrap(), "apple");
        assert!(detect_kind("outlook", &o).is_err());
    }

    fn source(id: &str) -> StoredSource {
        StoredSource {
            id: id.into(),
            name: "Work".into(),
            kind: "google".into(),
            color: "blue".into(),
            enabled: true,
            url: "https://calendar.google.com/calendar/ical/secret/basic.ics".into(),
            last_synced_at: None,
            last_error: None,
            last_attempt_at: None,
        }
    }

    #[test]
    fn cache_freshness() {
        let now = 1_000_000;
        let mut s = source("a");
        assert!(!is_fresh(&s, true, now));
        s.last_synced_at = Some(now - 60);
        assert!(is_fresh(&s, true, now));
        assert!(!is_fresh(&s, false, now));
        s.last_synced_at = Some(now - FRESH_SECS);
        assert!(!is_fresh(&s, true, now));
        // A recent failed attempt backs off even without a cache.
        s.last_attempt_at = Some(now - 30);
        s.last_error = Some("boom".into());
        assert!(is_fresh(&s, false, now));
        // A clock that went backwards is not "fresh".
        s.last_attempt_at = Some(now + 500);
        s.last_synced_at = Some(now + 500);
        assert!(!is_fresh(&s, true, now));
    }

    #[test]
    fn view_hides_url_and_store_round_trips() {
        let dir = tempdir().unwrap();
        modify_sources(dir.path(), |l| {
            l.push(source("abc"));
            Ok(())
        })
        .unwrap();
        record_fetch(dir.path(), "abc", Ok(cal("")), 42).unwrap();
        let list = load_sources(dir.path()).unwrap();
        assert_eq!(list[0].last_synced_at, Some(42));
        assert!(cache_path(dir.path(), "abc").exists());
        record_fetch(dir.path(), "abc", Err(AppError::Network("down".into())), 50).unwrap();
        let s = &load_sources(dir.path()).unwrap()[0];
        assert_eq!(s.last_synced_at, Some(42));
        assert_eq!(s.last_error.as_deref(), Some("Network: down"));
        let json = serde_json::to_string(&s.view()).unwrap();
        assert!(json.contains("\"urlHost\":\"calendar.google.com\""));
        assert!(json.contains("\"lastSyncedAt\":42"));
        assert!(!json.contains("secret"));
    }

    #[tokio::test]
    async fn fetch_validates_vcalendar() {
        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/ok.ics");
                then.status(200).body(cal(""));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/page");
                then.status(200).body("<html></html>");
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/gone");
                then.status(404);
            })
            .await;
        assert!(fetch_ics(&server.url("/ok.ics")).await.is_ok());
        match fetch_ics(&server.url("/page")).await {
            Err(AppError::Validation(m)) => assert_eq!(m, "Not an iCal calendar"),
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            fetch_ics(&server.url("/gone")).await,
            Err(AppError::Network(_))
        ));
    }

    // ── read-only guarantee ───────────────────────────────────────────────
    // The calendar integration only ever *reads* subscribed feeds. Vault
    // notes and web clippings are shown on the day timeline locally and
    // are never written or sent to any calendar.

    #[tokio::test]
    async fn fetch_only_issues_get_requests() {
        let server = httpmock::MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/feed.ics");
                then.status(200).body(cal(""));
            })
            .await;
        let mut writes = Vec::new();
        for m in [
            httpmock::Method::POST,
            httpmock::Method::PUT,
            httpmock::Method::PATCH,
            httpmock::Method::DELETE,
        ] {
            writes.push(
                server
                    .mock_async(|when, then| {
                        when.method(m).path("/feed.ics");
                        then.status(500);
                    })
                    .await,
            );
        }
        fetch_ics(&server.url("/feed.ics")).await.unwrap();
        get.assert_hits_async(1).await;
        for w in &writes {
            w.assert_hits_async(0).await;
        }
    }

    #[test]
    fn calendar_code_has_no_write_http_methods() {
        // Scan the non-test source of the calendar service and commands:
        // the only HTTP verb used is GET. Patterns are built at runtime
        // so this test's own text doesn't match.
        let strip_tests = |src: &'static str| src.split("#[cfg(test)]").next().unwrap_or(src);
        let sources = [
            strip_tests(include_str!("calendar.rs")),
            strip_tests(include_str!("../commands/calendar.rs")),
        ];
        let banned: Vec<String> = ["post", "put", "patch", "delete", "request"]
            .iter()
            .map(|v| format!(".{v}("))
            .chain(["Method::".to_string()])
            .collect();
        for src in sources {
            for b in &banned {
                assert!(!src.contains(b.as_str()), "calendar code uses `{b}`");
            }
        }
        assert_eq!(sources[0].matches(".get(url)").count(), 1);
    }

    #[test]
    fn calendar_events_never_include_vault_notes() {
        // A vault with timed notes and a clip on the same day as a feed
        // event: the calendar output holds only the feed's event, and the
        // note lookup only links meeting notes by `event_id`.
        let vault = tempdir().unwrap();
        let w = |rel: &str, body: &[u8]| {
            crate::services::fs::atomic_write(&vault.path().join(rel), body).unwrap()
        };
        w(
            "notes/n.md",
            b"---\ncreated: 2026-01-05T10:00:00Z\n---\nnote",
        );
        w(
            "notes/c.md",
            b"---\ncreated: 2026-01-05T11:00:00Z\nsource_url: https://x.com/a\n---\nclip",
        );
        w(
            "notes/m.md",
            b"---\nevent_id: a1@20260105T090000Z\n---\nmeeting",
        );
        let snap = crate::services::index::TagIndex::default()
            .get_or_build(vault.path())
            .unwrap();
        let lookup = note_lookup(&snap);
        assert_eq!(lookup.len(), 1, "{lookup:?}");
        assert_eq!(
            lookup.get("a1@20260105T090000Z").map(String::as_str),
            Some("notes/m.md")
        );

        let dir = tempdir().unwrap();
        modify_sources(dir.path(), |l| {
            l.push(source("s1"));
            Ok(())
        })
        .unwrap();
        let ics = cal(
            "BEGIN:VEVENT\r\nUID:a1\r\nSUMMARY:Standup\r\nDTSTART:20260105T090000Z\r\n\
             DTEND:20260105T093000Z\r\nEND:VEVENT\r\n",
        );
        record_fetch(dir.path(), "s1", Ok(ics), 1).unwrap();
        let sources = load_sources(dir.path()).unwrap();
        let events = events_from_cache(
            dir.path(),
            &sources,
            range("2026-01-04", "2026-01-07"),
            &|id| lookup.get(id).cloned(),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "a1@20260105T090000Z");
        assert_eq!(events[0].note_rel_path.as_deref(), Some("notes/m.md"));
        assert!(events.iter().all(|e| e.title == "Standup"));
        // No sources → no events, however many notes the vault holds.
        assert!(
            events_from_cache(dir.path(), &[], range("2026-01-04", "2026-01-07"), &|_| {
                None
            })
            .is_empty()
        );
    }
}
