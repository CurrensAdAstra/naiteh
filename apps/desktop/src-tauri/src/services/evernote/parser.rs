//! ENEX (.enex) file parser.
//!
//! Evernote's export format is XML at the outer layer with note content
//! held as CDATA-wrapped ENML (a slightly extended XHTML). This module
//! only deals with the outer structure — splitting an export into notes
//! and resources, decoding base64 attachments, and computing the MD5
//! hash that the body's `<en-media hash="...">` references. ENML →
//! Markdown conversion lives in `enml`.
//!
//! The parser is event-driven (quick-xml SAX) over a `BufReader<File>`
//! and yields notes **one at a time** through [`EnexReader`]: ENEX files
//! routinely run into the hundreds of megabytes for users with
//! image-heavy notebooks, so neither the file nor the full list of notes
//! is ever held in memory — only the note currently being parsed (plus
//! its decoded resources).

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use base64::Engine as _;
use chrono::{DateTime, NaiveDateTime, Utc};
use md5::{Digest, Md5};
use quick_xml::events::Event;
use quick_xml::reader::Reader;

use crate::domain::AppError;
use crate::services::evernote::enml::decode_entities;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EvernoteNote {
    pub title: String,
    /// Raw inner ENML body — the XML wrapped by `<content><![CDATA[...]]></content>`,
    /// including the `<en-note>` root. Conversion to Markdown is the
    /// `enml` module's job.
    pub content_xml: String,
    pub created: Option<DateTime<Utc>>,
    pub updated: Option<DateTime<Utc>>,
    pub tags: Vec<String>,
    pub source_url: Option<String>,
    pub author: Option<String>,
    pub resources: Vec<Resource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resource {
    pub mime: String,
    /// Original file name from `<resource-attributes><file-name>...</file-name></resource-attributes>`.
    /// May be missing — many web-clip images have none.
    pub file_name: Option<String>,
    pub data: Vec<u8>,
    /// Lowercase hex MD5 of `data`. Matches the `hash` attribute on
    /// `<en-media>` tags in note bodies.
    pub md5_hash_hex: String,
}

/// Streaming reader over an `.enex` document: [`EnexReader::next_note`]
/// (or the `Iterator` impl) parses just far enough to return the next
/// complete `<note>`, so callers can convert + write each note and drop
/// it before the next one is read.
pub struct EnexReader<R: BufRead> {
    reader: Reader<R>,
    buf: Vec<u8>,
    /// Path of element local-names from the root. We use the tail to
    /// decide where to direct text.
    path: Vec<String>,
    /// Text content accumulator for the *current leaf*. Cleared at the
    /// start of every "interesting leaf" so that mid-element text (e.g.
    /// whitespace between siblings) doesn't leak into the next field.
    text_buf: String,
    current: Option<EvernoteNote>,
    current_resource: Option<ResourceBuilder>,
    /// Set after EOF or an error; the iterator is then exhausted.
    finished: bool,
}

/// Open `path` for streaming. Errors only if the file can't be opened.
pub fn open_enex(path: &Path) -> Result<EnexReader<BufReader<File>>, AppError> {
    let file = File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            AppError::NotFound(format!("ENEX file not found: {}", path.display()))
        }
        _ => AppError::Io(format!("reading {}: {e}", path.display())),
    })?;
    Ok(EnexReader::new(BufReader::new(file)))
}

/// Count the `<note>` elements in `path` with a cheap streaming pass
/// (no base64 decoding, nothing retained), so progress can report a
/// total before the first note is written. Also validates that the
/// document is well-formed enough to import: a structurally broken file
/// fails here, before anything touches the vault.
pub fn count_notes(path: &Path) -> Result<usize, AppError> {
    let mut reader = open_enex(path)?;
    let mut count = 0usize;
    loop {
        match reader.reader.read_event_into(&mut reader.buf) {
            Ok(Event::Start(ref e)) => {
                let name = local_name_string(e.local_name().as_ref())?;
                if name == "note" {
                    count += 1;
                }
                reader.path.push(name);
            }
            Ok(Event::End(_)) => {
                reader.path.pop();
            }
            Ok(Event::Eof) => {
                reader.check_complete()?;
                return Ok(count);
            }
            Ok(_) => {}
            Err(e) => return Err(reader.parse_error(e)),
        }
        reader.buf.clear();
    }
}

impl<R: BufRead> EnexReader<R> {
    pub fn new(inner: R) -> Self {
        let mut reader = Reader::from_reader(inner);
        let cfg = reader.config_mut();
        cfg.trim_text(false); // CDATA whitespace matters for content
        cfg.expand_empty_elements = true;
        Self {
            reader,
            buf: Vec::new(),
            path: Vec::new(),
            text_buf: String::new(),
            current: None,
            current_resource: None,
            finished: false,
        }
    }

    fn parse_error(&self, e: quick_xml::Error) -> AppError {
        AppError::ConfigCorrupt(format!(
            "ENEX parse error at byte {}: {e}",
            self.reader.buffer_position()
        ))
    }

    /// quick-xml is lenient about unterminated tags — it just stops
    /// emitting events. If we're still inside an element when the
    /// stream ends, the input was truncated.
    fn check_complete(&self) -> Result<(), AppError> {
        if self.path.is_empty() {
            Ok(())
        } else {
            Err(AppError::ConfigCorrupt(format!(
                "ENEX truncated: unterminated <{}>",
                self.path.last().map(String::as_str).unwrap_or("?"),
            )))
        }
    }

    /// Parse up to and including the next `</note>`. `Ok(None)` at a
    /// clean end of document.
    pub fn next_note(&mut self) -> Result<Option<EvernoteNote>, AppError> {
        if self.finished {
            return Ok(None);
        }
        let result = self.advance();
        if !matches!(result, Ok(Some(_))) {
            self.finished = true;
        }
        result
    }

    fn advance(&mut self) -> Result<Option<EvernoteNote>, AppError> {
        loop {
            let event = self.reader.read_event_into(&mut self.buf);
            let completed = match event {
                Ok(Event::Start(ref e)) => {
                    let name = local_name_string(e.local_name().as_ref())?;
                    if is_interesting_leaf(&name) {
                        self.text_buf.clear();
                    }
                    match name.as_str() {
                        "note" => self.current = Some(EvernoteNote::default()),
                        "resource" => self.current_resource = Some(ResourceBuilder::default()),
                        _ => {}
                    }
                    self.path.push(name);
                    None
                }
                Ok(Event::End(_)) => {
                    let name = self.path.pop().unwrap_or_default();
                    dispatch_text(
                        &self.path,
                        &name,
                        std::mem::take(&mut self.text_buf),
                        self.current.as_mut(),
                        self.current_resource.as_mut(),
                    )?;
                    match name.as_str() {
                        "note" => self.current.take(),
                        "resource" => {
                            if let (Some(rb), Some(n)) =
                                (self.current_resource.take(), self.current.as_mut())
                            {
                                if let Some(r) = rb.build()? {
                                    n.resources.push(r);
                                }
                            }
                            None
                        }
                        _ => None,
                    }
                }
                Ok(Event::Text(t)) => {
                    // Lenient entity decoding (HTML named entities,
                    // numeric refs; unknown ones kept literally) instead
                    // of quick-xml's 5-entity `unescape`.
                    let raw = std::str::from_utf8(t.as_ref())
                        .map_err(|e| AppError::ConfigCorrupt(format!("ENEX text utf-8: {e}")))?;
                    self.text_buf.push_str(&decode_entities(raw));
                    None
                }
                Ok(Event::CData(c)) => {
                    let s = std::str::from_utf8(c.as_ref())
                        .map_err(|e| AppError::ConfigCorrupt(format!("ENEX CDATA utf-8: {e}")))?;
                    self.text_buf.push_str(s);
                    None
                }
                Ok(Event::Eof) => {
                    self.check_complete()?;
                    return Ok(None);
                }
                Ok(_) => None,
                Err(e) => return Err(self.parse_error(e)),
            };
            self.buf.clear();
            if let Some(note) = completed {
                return Ok(Some(note));
            }
        }
    }
}

impl<R: BufRead> Iterator for EnexReader<R> {
    type Item = Result<EvernoteNote, AppError>;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_note().transpose()
    }
}

/// Parse an in-memory ENEX document into all of its notes. Test
/// convenience only — production code streams via [`open_enex`].
#[cfg(test)]
pub fn parse_enex_bytes(bytes: &[u8]) -> Result<Vec<EvernoteNote>, AppError> {
    EnexReader::new(bytes).collect()
}

#[derive(Default)]
struct ResourceBuilder {
    mime: Option<String>,
    file_name: Option<String>,
    data_b64: String,
}

impl ResourceBuilder {
    fn build(self) -> Result<Option<Resource>, AppError> {
        if self.data_b64.is_empty() {
            // No data → not useful as an attachment. Silently drop.
            return Ok(None);
        }
        let cleaned: String = self
            .data_b64
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(cleaned.as_bytes())
            .map_err(|e| AppError::ConfigCorrupt(format!("base64 resource decode: {e}")))?;
        let mut hasher = Md5::new();
        hasher.update(&bytes);
        let md5_hash_hex = hex_lower(&hasher.finalize());
        Ok(Some(Resource {
            mime: self
                .mime
                .unwrap_or_else(|| "application/octet-stream".into()),
            file_name: self.file_name,
            data: bytes,
            md5_hash_hex,
        }))
    }
}

fn is_interesting_leaf(name: &str) -> bool {
    matches!(
        name,
        "title"
            | "created"
            | "updated"
            | "tag"
            | "source-url"
            | "author"
            | "content"
            | "mime"
            | "data"
            | "file-name"
    )
}

fn dispatch_text(
    parent_path: &[String],
    leaf_name: &str,
    text: String,
    note: Option<&mut EvernoteNote>,
    resource: Option<&mut ResourceBuilder>,
) -> Result<(), AppError> {
    // Most fields belong to the most-recent <note>. Resource fields belong
    // to the most-recent <resource>. We pick based on whether we're inside
    // a <resource> subtree (i.e. "resource" appears in the parent path).
    let in_resource = parent_path.iter().rev().any(|p| p == "resource");

    if in_resource {
        if let Some(r) = resource {
            match leaf_name {
                "mime" => r.mime = Some(text.trim().to_string()),
                "data" => r.data_b64.push_str(&text),
                "file-name" => {
                    let s = text.trim();
                    if !s.is_empty() {
                        r.file_name = Some(s.to_string());
                    }
                }
                _ => {}
            }
        }
        return Ok(());
    }

    let Some(n) = note else { return Ok(()) };
    match leaf_name {
        "title" => n.title = text.trim().to_string(),
        "content" => n.content_xml = text,
        "created" => n.created = parse_evernote_date(text.trim()),
        "updated" => n.updated = parse_evernote_date(text.trim()),
        "tag" => {
            let t = text.trim();
            if !t.is_empty() {
                n.tags.push(t.to_string());
            }
        }
        "source-url" => {
            let s = text.trim();
            if !s.is_empty() {
                n.source_url = Some(s.to_string());
            }
        }
        "author" => {
            let s = text.trim();
            if !s.is_empty() {
                n.author = Some(s.to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

fn parse_evernote_date(s: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(s, "%Y%m%dT%H%M%SZ")
        .ok()
        .map(|naive| naive.and_utc())
}

fn local_name_string(bytes: &[u8]) -> Result<String, AppError> {
    std::str::from_utf8(bytes)
        .map(str::to_string)
        .map_err(|e| AppError::ConfigCorrupt(format!("ENEX element name utf-8: {e}")))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(y: i32, m: u32, d: u32, hh: u32, mm: u32, ss: u32) -> DateTime<Utc> {
        chrono::TimeZone::with_ymd_and_hms(&Utc, y, m, d, hh, mm, ss).unwrap()
    }

    const TINY_ENEX: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<en-export export-date="20260512T103000Z" application="Evernote/Mac" version="10.0">
  <note>
    <title>Hello Note</title>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note><div>Hello <b>world</b></div></en-note>]]></content>
    <created>20260101T123000Z</created>
    <updated>20260112T080000Z</updated>
    <tag>work</tag>
    <tag>urgent</tag>
    <note-attributes>
      <author>Mingi</author>
      <source-url>https://example.com</source-url>
    </note-attributes>
  </note>
</en-export>"#;

    #[test]
    fn parses_a_single_note_with_metadata() {
        let notes = parse_enex_bytes(TINY_ENEX.as_bytes()).unwrap();
        assert_eq!(notes.len(), 1);
        let n = &notes[0];
        assert_eq!(n.title, "Hello Note");
        assert!(n.content_xml.contains("<en-note>"));
        assert!(n.content_xml.contains("Hello <b>world</b>"));
        assert_eq!(n.created, Some(dt(2026, 1, 1, 12, 30, 0)));
        assert_eq!(n.updated, Some(dt(2026, 1, 12, 8, 0, 0)));
        assert_eq!(n.tags, vec!["work", "urgent"]);
        assert_eq!(n.author.as_deref(), Some("Mingi"));
        assert_eq!(n.source_url.as_deref(), Some("https://example.com"));
        assert!(n.resources.is_empty());
    }

    #[test]
    fn parses_multiple_notes() {
        let enex = r#"<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note><title>A</title><content><![CDATA[<en-note>a</en-note>]]></content></note>
  <note><title>B</title><content><![CDATA[<en-note>b</en-note>]]></content></note>
</en-export>"#;
        let notes = parse_enex_bytes(enex.as_bytes()).unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].title, "A");
        assert_eq!(notes[1].title, "B");
    }

    #[test]
    fn decodes_resources_and_hashes_with_md5() {
        // base64("hello") = "aGVsbG8="
        // md5("hello") = "5d41402abc4b2a76b9719d911017c592"
        let enex = r#"<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>With attachment</title>
    <content><![CDATA[<en-note><en-media hash="5d41402abc4b2a76b9719d911017c592" type="text/plain"/></en-note>]]></content>
    <resource>
      <data encoding="base64">aGVsbG8=</data>
      <mime>text/plain</mime>
      <resource-attributes>
        <file-name>greeting.txt</file-name>
      </resource-attributes>
    </resource>
  </note>
</en-export>"#;
        let notes = parse_enex_bytes(enex.as_bytes()).unwrap();
        assert_eq!(notes.len(), 1);
        let r = &notes[0].resources[0];
        assert_eq!(r.mime, "text/plain");
        assert_eq!(r.file_name.as_deref(), Some("greeting.txt"));
        assert_eq!(r.data, b"hello");
        assert_eq!(r.md5_hash_hex, "5d41402abc4b2a76b9719d911017c592");
    }

    #[test]
    fn base64_whitespace_is_tolerated() {
        // Real exports split base64 across many lines.
        let enex = r#"<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>Chunked</title>
    <content><![CDATA[<en-note/>]]></content>
    <resource>
      <data encoding="base64">
        aGVs
        bG8=
      </data>
      <mime>text/plain</mime>
    </resource>
  </note>
</en-export>"#;
        let notes = parse_enex_bytes(enex.as_bytes()).unwrap();
        assert_eq!(notes[0].resources[0].data, b"hello");
    }

    #[test]
    fn missing_optional_fields_are_none_not_empty() {
        let enex = r#"<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>Bare</title>
    <content><![CDATA[<en-note/>]]></content>
  </note>
</en-export>"#;
        let n = &parse_enex_bytes(enex.as_bytes()).unwrap()[0];
        assert!(n.created.is_none());
        assert!(n.updated.is_none());
        assert!(n.tags.is_empty());
        assert!(n.source_url.is_none());
        assert!(n.author.is_none());
    }

    #[test]
    fn malformed_xml_returns_config_corrupt() {
        let enex = b"<en-export><note><title>unterminated";
        let err = parse_enex_bytes(enex).unwrap_err();
        match err {
            AppError::ConfigCorrupt(msg) => assert!(msg.contains("ENEX")),
            other => panic!("expected ConfigCorrupt, got {other:?}"),
        }
    }

    #[test]
    fn reader_streams_notes_one_at_a_time() {
        // Second note is truncated: the first must still come out intact
        // before the error surfaces — proof we don't parse the whole
        // document up front.
        let enex = r#"<?xml version="1.0"?>
<en-export>
  <note><title>First</title><content><![CDATA[<en-note>a</en-note>]]></content></note>
  <note><title>Second"#;
        let mut reader = EnexReader::new(enex.as_bytes());
        let first = reader.next_note().unwrap().unwrap();
        assert_eq!(first.title, "First");
        assert!(reader.next_note().is_err());
        // Exhausted after an error.
        assert!(reader.next_note().unwrap().is_none());
    }

    #[test]
    fn open_and_count_stream_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.enex");
        std::fs::write(
            &p,
            r#"<?xml version="1.0"?>
<en-export>
  <note><title>A</title><content><![CDATA[<en-note/>]]></content></note>
  <note><title>B</title><content><![CDATA[<en-note/>]]></content></note>
</en-export>"#,
        )
        .unwrap();
        assert_eq!(count_notes(&p).unwrap(), 2);
        let titles: Vec<String> = open_enex(&p).unwrap().map(|n| n.unwrap().title).collect();
        assert_eq!(titles, vec!["A", "B"]);
    }

    #[test]
    fn count_notes_rejects_truncated_file_and_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bad.enex");
        std::fs::write(&p, "<en-export><note><title>x</title>").unwrap();
        assert!(matches!(count_notes(&p), Err(AppError::ConfigCorrupt(_))));
        assert!(matches!(
            count_notes(&dir.path().join("missing.enex")),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn html_entities_in_outer_fields_do_not_fail_the_file() {
        let enex = r#"<?xml version="1.0"?>
<en-export>
  <note>
    <title>A&nbsp;B &mdash; C &unknown;</title>
    <content><![CDATA[<en-note/>]]></content>
  </note>
</en-export>"#;
        let n = &parse_enex_bytes(enex.as_bytes()).unwrap()[0];
        assert_eq!(n.title, "A\u{a0}B — C &unknown;");
    }

    #[test]
    fn entities_in_title_are_decoded() {
        let enex = r#"<?xml version="1.0"?>
<en-export>
  <note>
    <title>Plan &amp; Notes</title>
    <content><![CDATA[<en-note/>]]></content>
  </note>
</en-export>"#;
        let n = &parse_enex_bytes(enex.as_bytes()).unwrap()[0];
        assert_eq!(n.title, "Plan & Notes");
    }
}
