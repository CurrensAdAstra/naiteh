//! ENML → Markdown converter.
//!
//! ENML is HTML wrapped in `<en-note>` plus a few Evernote-specific
//! tags (`<en-todo>`, `<en-media>`). We translate to CommonMark with
//! a few sensible defaults:
//!   - headings, paragraphs, blockquotes, hr stay 1:1
//!   - lists handle nesting via an explicit indent stack
//!   - `<en-todo checked="true|false"/>` becomes `- [x] ` / `- [ ] `
//!   - `<en-media hash="..."/>` is replaced by a caller-supplied
//!     markdown snippet (image or link) keyed by hash; missing
//!     hashes leave a `[missing attachment: HASH]` placeholder so
//!     the user knows something was dropped
//!   - tables collapse to simple pipe tables (no colspan/rowspan)
//!
//! What we do **not** try to preserve:
//!   - inline CSS / color / font choices
//!   - underline (Markdown has none; we drop it silently)
//!   - handwritten "ink" notes — these arrive as `application/vnd.evernote.ink`
//!     resources and the body has no rendering; the importer logs a warning
//!
//! The result is a String the caller writes to disk. We do not add
//! a trailing newline — the caller controls that.

use std::collections::HashMap;

use quick_xml::events::{BytesEnd, BytesStart, Event};
use quick_xml::reader::Reader;

use crate::domain::AppError;

/// Convert ENML XML to Markdown.
///
/// `resources_md` maps the lowercase hex MD5 of a resource to the
/// markdown snippet to substitute for the matching `<en-media>` tag —
/// e.g. `"![](img-1.png)"` for images, `"[plan.pdf](plan.pdf)"` for files.
pub fn enml_to_markdown(
    xml: &str,
    resources_md: &HashMap<String, String>,
) -> Result<String, AppError> {
    let mut reader = Reader::from_str(xml);
    let cfg = reader.config_mut();
    cfg.trim_text(false);
    cfg.expand_empty_elements = false; // we handle <foo/> distinctly

    let mut state = ConverterState::new(resources_md);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => state.handle_start(e)?,
            Ok(Event::End(ref e)) => state.handle_end(e)?,
            Ok(Event::Empty(ref e)) => state.handle_empty(e)?,
            Ok(Event::Text(t)) => {
                // Not `t.unescape()`: quick-xml only knows the five XML
                // entities, and ENML routinely carries HTML ones
                // (`&nbsp;`, `&mdash;`, …). One of those used to fail
                // the whole note.
                let raw = std::str::from_utf8(t.as_ref())
                    .map_err(|err| AppError::ConfigCorrupt(format!("ENML text utf-8: {err}")))?;
                state.handle_text(&decode_entities(raw));
            }
            Ok(Event::CData(c)) => {
                let s = std::str::from_utf8(c.as_ref())
                    .map_err(|err| AppError::ConfigCorrupt(format!("ENML CDATA utf-8: {err}")))?;
                state.handle_text(s);
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => {
                return Err(AppError::ConfigCorrupt(format!(
                    "ENML parse error at byte {}: {e}",
                    reader.buffer_position()
                )))
            }
        }
        buf.clear();
    }

    Ok(state.finish())
}

struct ConverterState<'a> {
    out: String,
    resources_md: &'a HashMap<String, String>,
    list_stack: Vec<ListCtx>,
    in_pre: bool,
    in_inline_code: bool,
    /// True while we're inside a block whose text should not be
    /// markdown-escaped (currently just `<pre>` / `<code>` blocks).
    raw_text: bool,
    /// Number of nested `<blockquote>` levels.
    quote_depth: usize,
    /// Active table being built. Markdown tables can't nest, so this is
    /// `Option`, not a stack.
    table: Option<TableCtx>,
    /// Per-line buffer for table cells (between `<td>` and `</td>`).
    cell_buf: Option<String>,
    /// We just finished a block element; the next block-level write
    /// should ensure a blank line is present.
    need_block_break: bool,
    /// One entry per open `<a>`: the sanitized, Markdown-safe href, or
    /// `None` when the anchor had no usable href (then its text is
    /// emitted plain, without `[...]()` around it).
    link_stack: Vec<Option<String>>,
}

#[derive(Debug)]
struct ListCtx {
    ordered: bool,
    counter: usize,
}

#[derive(Debug, Default)]
struct TableCtx {
    rows: Vec<Vec<String>>,
    current_row: Vec<String>,
}

impl<'a> ConverterState<'a> {
    fn new(resources_md: &'a HashMap<String, String>) -> Self {
        Self {
            out: String::new(),
            resources_md,
            list_stack: Vec::new(),
            in_pre: false,
            in_inline_code: false,
            raw_text: false,
            quote_depth: 0,
            table: None,
            cell_buf: None,
            need_block_break: false,
            link_stack: Vec::new(),
        }
    }

    fn handle_start(&mut self, e: &BytesStart<'_>) -> Result<(), AppError> {
        let name = local_name(e.local_name().as_ref())?;
        match name.as_str() {
            "en-note" | "div" | "section" | "article" | "body" | "html" => {
                // Transparent block containers — preserve block break semantics
                // without emitting anything ourselves.
            }
            "p" => self.start_block(),
            "br" => self.write_inline("\n"),
            "h1" => self.start_block_with_prefix("# "),
            "h2" => self.start_block_with_prefix("## "),
            "h3" => self.start_block_with_prefix("### "),
            "h4" => self.start_block_with_prefix("#### "),
            "h5" => self.start_block_with_prefix("##### "),
            "h6" => self.start_block_with_prefix("###### "),
            "blockquote" => {
                self.start_block();
                self.quote_depth += 1;
                // No eager "> " — `ensure_quote_prefix` writes it lazily
                // at the start of each line so subsequent paragraph
                // breaks pick up the right depth.
            }
            "hr" => {
                self.start_block();
                self.out.push_str("---");
                self.need_block_break = true;
            }
            "ul" | "ol" => {
                if self.list_stack.is_empty() {
                    self.start_block();
                }
                self.list_stack.push(ListCtx {
                    ordered: name == "ol",
                    counter: 1,
                });
            }
            "li" => self.start_list_item(),
            "pre" => {
                self.start_block();
                self.out.push_str("```\n");
                self.in_pre = true;
                self.raw_text = true;
            }
            "code" => {
                if self.in_pre {
                    // <pre><code>...</code></pre> — fence already opened
                } else {
                    self.out.push('`');
                    self.in_inline_code = true;
                    self.raw_text = true;
                }
            }
            "b" | "strong" => self.write_inline("**"),
            "i" | "em" => self.write_inline("*"),
            "s" | "strike" | "del" => self.write_inline("~~"),
            "a" => {
                let href = attr_value(e, b"href").and_then(|h| sanitize_url(&h));
                if href.is_some() {
                    self.write_inline("[");
                }
                self.link_stack.push(href);
            }
            "table" => {
                self.start_block();
                self.table = Some(TableCtx::default());
            }
            "tr" => {
                if let Some(t) = self.table.as_mut() {
                    t.current_row.clear();
                }
            }
            "td" | "th" if self.table.is_some() => {
                self.cell_buf = Some(String::new());
            }
            // Unknown elements: be a transparent passthrough so any
            // text content still surfaces.
            _ => {}
        }
        Ok(())
    }

    fn handle_end(&mut self, e: &BytesEnd<'_>) -> Result<(), AppError> {
        let name = local_name(e.local_name().as_ref())?;
        match name.as_str() {
            "en-note" | "div" | "section" | "article" | "body" | "html" => {
                self.need_block_break = true;
            }
            "p" => self.need_block_break = true,
            "br" => {}
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.need_block_break = true;
            }
            "blockquote" => {
                self.quote_depth = self.quote_depth.saturating_sub(1);
                self.need_block_break = true;
            }
            "hr" => {}
            "ul" | "ol" => {
                self.list_stack.pop();
                if self.list_stack.is_empty() {
                    self.need_block_break = true;
                }
            }
            "li" => {
                // Bumping the counter happens in start_list_item so
                // nested lists don't bump the wrong one.
                self.out.push('\n');
            }
            "pre" => {
                if !self.out.ends_with('\n') {
                    self.out.push('\n');
                }
                self.out.push_str("```");
                self.in_pre = false;
                self.raw_text = false;
                self.need_block_break = true;
            }
            "code" => {
                if self.in_inline_code {
                    self.out.push('`');
                    self.in_inline_code = false;
                    self.raw_text = false;
                }
            }
            "b" | "strong" => self.write_inline("**"),
            "i" | "em" => self.write_inline("*"),
            "s" | "strike" | "del" => self.write_inline("~~"),
            "a" => {
                if let Some(Some(href)) = self.link_stack.pop() {
                    self.write_inline(&format!("]({href})"));
                }
            }
            "table" => {
                if let Some(t) = self.table.take() {
                    self.emit_pipe_table(t);
                    self.need_block_break = true;
                }
            }
            "tr" => {
                if let Some(t) = self.table.as_mut() {
                    let row = std::mem::take(&mut t.current_row);
                    t.rows.push(row);
                }
            }
            "td" | "th" => {
                if let Some(buf) = self.cell_buf.take() {
                    if let Some(t) = self.table.as_mut() {
                        t.current_row.push(buf.trim().replace('\n', " "));
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn handle_empty(&mut self, e: &BytesStart<'_>) -> Result<(), AppError> {
        let name = local_name(e.local_name().as_ref())?;
        match name.as_str() {
            "br" => self.write_inline("  \n"), // hard line break in MD
            "hr" => {
                self.start_block();
                self.out.push_str("---");
                self.need_block_break = true;
            }
            "img" => {
                let src = attr_value(e, b"src").and_then(|s| sanitize_url(&s));
                let alt = attr_value(e, b"alt").unwrap_or_default();
                if let Some(src) = src {
                    let alt = escape_link_text(&alt);
                    self.write_inline(&format!("![{alt}]({src})"));
                }
            }
            "en-todo" => {
                let checked = attr_value(e, b"checked")
                    .map(|v| matches!(v.trim(), "true" | "True" | "TRUE" | "1"))
                    .unwrap_or(false);
                // A todo starts its own line; consume any pending block
                // break so the text that follows stays on the same line
                // as the checkbox.
                self.need_block_break = false;
                if !self.at_line_start() {
                    self.out.push('\n');
                }
                self.ensure_quote_prefix();
                self.out.push_str(if checked { "- [x] " } else { "- [ ] " });
            }
            "en-media" => {
                let hash = attr_value(e, b"hash")
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let mime = attr_value(e, b"type").unwrap_or_default();
                let placeholder = match self.resources_md.get(&hash) {
                    Some(md) => md.clone(),
                    // Attribute values are untrusted: escape them so a
                    // crafted hash can't smuggle in link syntax.
                    None => format!(
                        "[missing attachment: {} ({})]",
                        escape_md(&hash),
                        escape_md(&mime)
                    ),
                };
                self.write_inline(&placeholder);
            }
            // For other "empty" elements treat as a no-op.
            _ => {}
        }
        Ok(())
    }

    fn handle_text(&mut self, text: &str) {
        if let Some(cell) = self.cell_buf.as_mut() {
            // Inside a table cell — buffer instead of writing.
            cell.push_str(text);
            return;
        }

        // Handle `<a href="...">` by recording href when we see it.
        // We hold the href on self.last_attr_href… but we need to set
        // that when we see `<a>` start. Let's intercept here instead by
        // not touching it.

        if self.raw_text {
            self.out.push_str(text);
            return;
        }

        // Collapse leading/trailing whitespace nodes between blocks —
        // ENML is HTML and uses indent whitespace liberally.
        if self.need_block_break && text.trim().is_empty() {
            return;
        }

        let escaped = if self.in_pre || self.in_inline_code {
            text.to_string()
        } else {
            escape_md(text)
        };
        if !escaped.is_empty() {
            self.flush_block_break();
            self.ensure_quote_prefix();
            self.out.push_str(&escaped);
        }
    }

    fn start_block(&mut self) {
        self.flush_block_break();
        if !self.out.is_empty() && !self.out.ends_with("\n\n") {
            if self.out.ends_with('\n') {
                self.out.push('\n');
            } else {
                self.out.push_str("\n\n");
            }
        }
        self.need_block_break = false;
        self.ensure_quote_prefix();
    }

    fn start_block_with_prefix(&mut self, prefix: &str) {
        self.start_block();
        self.out.push_str(prefix);
    }

    fn start_list_item(&mut self) {
        // Newline before each item (unless we're at the very start
        // of the list — handled because start_block was already called
        // by `<ul>`/`<ol>` start).
        if !self.at_line_start() {
            self.out.push('\n');
        }
        self.ensure_quote_prefix();
        let depth = self.list_stack.len().saturating_sub(1);
        for _ in 0..depth {
            self.out.push_str("  ");
        }
        if let Some(top) = self.list_stack.last_mut() {
            if top.ordered {
                self.out.push_str(&format!("{}. ", top.counter));
                top.counter += 1;
            } else {
                self.out.push_str("- ");
            }
        }
    }

    /// Write `> ` × quote_depth once if we're at the start of a fresh
    /// line and inside a blockquote. Idempotent within a single line:
    /// `at_line_start` becomes false after the first call, so further
    /// writes on the same line won't double-prefix.
    fn ensure_quote_prefix(&mut self) {
        if self.quote_depth == 0 || self.cell_buf.is_some() {
            return;
        }
        if self.at_line_start() {
            for _ in 0..self.quote_depth {
                self.out.push_str("> ");
            }
        }
    }

    fn write_inline(&mut self, s: &str) {
        if let Some(cell) = self.cell_buf.as_mut() {
            cell.push_str(s);
        } else {
            self.flush_block_break();
            self.ensure_quote_prefix();
            self.out.push_str(s);
        }
    }

    fn flush_block_break(&mut self) {
        if self.need_block_break {
            if !self.out.is_empty() {
                if self.out.ends_with("\n\n") {
                    // already separated
                } else if self.out.ends_with('\n') {
                    self.out.push('\n');
                } else {
                    self.out.push_str("\n\n");
                }
            }
            self.need_block_break = false;
        }
    }

    fn emit_pipe_table(&mut self, t: TableCtx) {
        if t.rows.is_empty() {
            return;
        }
        let cols = t.rows.iter().map(|r| r.len()).max().unwrap_or(0);
        if cols == 0 {
            return;
        }
        self.flush_block_break();
        if !self.out.is_empty() && !self.out.ends_with('\n') {
            self.out.push('\n');
        }
        for (i, row) in t.rows.iter().enumerate() {
            let cells: Vec<String> = (0..cols)
                .map(|c| row.get(c).cloned().unwrap_or_default())
                .collect();
            self.out.push_str("| ");
            self.out.push_str(&cells.join(" | "));
            self.out.push_str(" |\n");
            if i == 0 {
                self.out.push_str("| ");
                self.out
                    .push_str(&(0..cols).map(|_| "---").collect::<Vec<_>>().join(" | "));
                self.out.push_str(" |\n");
            }
        }
    }

    fn at_line_start(&self) -> bool {
        self.out.is_empty() || self.out.ends_with('\n')
    }

    fn finish(mut self) -> String {
        // Trim trailing whitespace + collapse runs of >2 newlines to 2.
        while self.out.ends_with(|c: char| c.is_whitespace()) {
            self.out.pop();
        }
        self.out
    }
}

/// Value of attribute `name` (by local name) with entities decoded
/// leniently (see [`decode_entities`]). `None` if absent or not UTF-8.
fn attr_value(e: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    e.attributes()
        .with_checks(false)
        .flatten()
        .find(|a| a.key.local_name().as_ref() == name)
        .and_then(|a| {
            std::str::from_utf8(a.value.as_ref())
                .ok()
                .map(decode_entities)
        })
}

/// Decode XML/HTML character references in `raw`, leniently.
///
/// Handles numeric references (`&#160;`, `&#xA0;`) and the common HTML
/// named entities ENML exports actually contain. Anything unknown or
/// malformed (`&foo;`, a bare `&`) is kept as literal text instead of
/// failing the whole note.
pub(crate) fn decode_entities(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        // Entity names are short; don't scan arbitrarily far for ';'.
        let semi = after
            .char_indices()
            .take(33)
            .find(|&(_, c)| c == ';')
            .map(|(i, _)| i);
        let decoded = semi.and_then(|end| decode_reference(&after[..end]).map(|c| (c, end)));
        match decoded {
            Some((ch, end)) => {
                out.push(ch);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Decode the body of one `&...;` reference (without `&` and `;`).
fn decode_reference(name: &str) -> Option<char> {
    if let Some(num) = name.strip_prefix('#') {
        let code = if let Some(hex) = num.strip_prefix(['x', 'X']) {
            u32::from_str_radix(hex, 16).ok()?
        } else {
            num.parse::<u32>().ok()?
        };
        // NUL is not a legal character reference; map it to U+FFFD
        // like browsers do rather than embedding a NUL in the note.
        return match code {
            0 => Some('\u{FFFD}'),
            c => char::from_u32(c).or(Some('\u{FFFD}')),
        };
    }
    named_entity(name)
}

/// HTML named entities commonly found in ENML. Case-sensitive, as in
/// HTML (`&Eacute;` ≠ `&eacute;`).
fn named_entity(name: &str) -> Option<char> {
    Some(match name {
        // XML's predefined five
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        // spaces & invisible formatting
        "nbsp" => '\u{00A0}',
        "ensp" => '\u{2002}',
        "emsp" => '\u{2003}',
        "thinsp" => '\u{2009}',
        "shy" => '\u{00AD}',
        "zwj" => '\u{200D}',
        "zwnj" => '\u{200C}',
        "lrm" => '\u{200E}',
        "rlm" => '\u{200F}',
        // punctuation
        "hellip" => '…',
        "mdash" => '—',
        "ndash" => '–',
        "lsquo" => '‘',
        "rsquo" => '’',
        "sbquo" => '‚',
        "ldquo" => '“',
        "rdquo" => '”',
        "bdquo" => '„',
        "bull" => '•',
        "middot" => '·',
        "laquo" => '«',
        "raquo" => '»',
        "lsaquo" => '‹',
        "rsaquo" => '›',
        "iexcl" => '¡',
        "iquest" => '¿',
        "sect" => '§',
        "para" => '¶',
        "dagger" => '†',
        "Dagger" => '‡',
        "prime" => '′',
        "Prime" => '″',
        "permil" => '‰',
        // symbols
        "copy" => '©',
        "reg" => '®',
        "trade" => '™',
        "deg" => '°',
        "plusmn" => '±',
        "times" => '×',
        "divide" => '÷',
        "micro" => 'µ',
        "frac12" => '½',
        "frac14" => '¼',
        "frac34" => '¾',
        "sup1" => '¹',
        "sup2" => '²',
        "sup3" => '³',
        "not" => '¬',
        "minus" => '−',
        "ne" => '≠',
        "le" => '≤',
        "ge" => '≥',
        "infin" => '∞',
        "larr" => '←',
        "rarr" => '→',
        "uarr" => '↑',
        "darr" => '↓',
        "harr" => '↔',
        "hearts" => '♥',
        "check" => '✓',
        // currency
        "euro" => '€',
        "pound" => '£',
        "yen" => '¥',
        "cent" => '¢',
        "curren" => '¤',
        // common Latin-1 letters
        "agrave" => 'à',
        "aacute" => 'á',
        "acirc" => 'â',
        "atilde" => 'ã',
        "auml" => 'ä',
        "aring" => 'å',
        "aelig" => 'æ',
        "ccedil" => 'ç',
        "egrave" => 'è',
        "eacute" => 'é',
        "ecirc" => 'ê',
        "euml" => 'ë',
        "igrave" => 'ì',
        "iacute" => 'í',
        "icirc" => 'î',
        "iuml" => 'ï',
        "ntilde" => 'ñ',
        "ograve" => 'ò',
        "oacute" => 'ó',
        "ocirc" => 'ô',
        "otilde" => 'õ',
        "ouml" => 'ö',
        "oslash" => 'ø',
        "ugrave" => 'ù',
        "uacute" => 'ú',
        "ucirc" => 'û',
        "uuml" => 'ü',
        "yacute" => 'ý',
        "yuml" => 'ÿ',
        "szlig" => 'ß',
        "Agrave" => 'À',
        "Aacute" => 'Á',
        "Acirc" => 'Â',
        "Atilde" => 'Ã',
        "Auml" => 'Ä',
        "Aring" => 'Å',
        "AElig" => 'Æ',
        "Ccedil" => 'Ç',
        "Egrave" => 'È',
        "Eacute" => 'É',
        "Ecirc" => 'Ê',
        "Euml" => 'Ë',
        "Ntilde" => 'Ñ',
        "Oacute" => 'Ó',
        "Ouml" => 'Ö',
        "Oslash" => 'Ø',
        "Uacute" => 'Ú',
        "Uuml" => 'Ü',
        _ => return None,
    })
}

/// Make an untrusted URL safe to embed as a Markdown link destination.
///
/// - Drops `javascript:`, `vbscript:` and `data:` URLs (except
///   `data:image/*` other than SVG, which can carry script). The scheme
///   check ignores case and embedded whitespace/control characters,
///   since browsers do (`java\tscript:` is `javascript:`).
/// - Percent-encodes characters that would end or break the `(...)`
///   destination: spaces, `(`, `)`, `<`, `>`, and all control
///   characters (newlines included).
///
/// Returns `None` for an empty or disallowed URL.
pub(crate) fn sanitize_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let squashed: String = trimmed
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .collect::<String>()
        .to_ascii_lowercase();
    // Scheme = text before the first ':' if that comes before any of
    // '/', '?', '#' (otherwise it's a relative path containing ':').
    let scheme = squashed
        .find(':')
        .filter(|&colon| !squashed[..colon].contains(['/', '?', '#']))
        .map(|colon| &squashed[..colon]);
    match scheme {
        Some("javascript") | Some("vbscript") | Some("livescript") => return None,
        Some("data") => {
            let is_raster_image =
                squashed.starts_with("data:image/") && !squashed.starts_with("data:image/svg");
            if !is_raster_image {
                return None;
            }
        }
        _ => {}
    }
    let mut out = String::with_capacity(trimmed.len());
    for c in trimmed.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            c if c.is_control() || c.is_whitespace() => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
            c => out.push(c),
        }
    }
    Some(out)
}

/// Escape text that will sit inside `[...]` / `![...]` so it can't
/// close the bracket early or start a nested link.
fn escape_link_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' | '[' | ']' => {
                out.push('\\');
                out.push(c);
            }
            '\n' | '\r' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

fn local_name(bytes: &[u8]) -> Result<String, AppError> {
    std::str::from_utf8(bytes)
        .map(|s| s.to_ascii_lowercase())
        .map_err(|err| AppError::ConfigCorrupt(format!("ENML element name utf-8: {err}")))
}

fn escape_md(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '#' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convert(xml: &str) -> String {
        enml_to_markdown(xml, &HashMap::new()).unwrap()
    }

    #[test]
    fn plain_paragraph() {
        let md = convert("<en-note><p>Hello world</p></en-note>");
        assert_eq!(md, "Hello world");
    }

    #[test]
    fn headings() {
        let md = convert("<en-note><h1>Big</h1><h3>Smaller</h3></en-note>");
        assert_eq!(md, "# Big\n\n### Smaller");
    }

    #[test]
    fn bold_italic_strike() {
        let md = convert("<en-note><p><b>bold</b> and <i>italic</i> and <s>gone</s></p></en-note>");
        assert_eq!(md, "**bold** and *italic* and ~~gone~~");
    }

    #[test]
    fn unordered_list() {
        let md = convert("<en-note><ul><li>One</li><li>Two</li></ul></en-note>");
        assert_eq!(md, "- One\n- Two");
    }

    #[test]
    fn ordered_list_counts_from_one() {
        let md = convert("<en-note><ol><li>One</li><li>Two</li></ol></en-note>");
        assert_eq!(md, "1. One\n2. Two");
    }

    #[test]
    fn en_todo_renders_checkboxes() {
        let md = convert(
            r#"<en-note><div><en-todo/>Buy milk</div><div><en-todo checked="true"/>Walk dog</div></en-note>"#,
        );
        assert!(md.contains("- [ ] Buy milk"), "got: {md:?}");
        assert!(md.contains("- [x] Walk dog"), "got: {md:?}");
    }

    #[test]
    fn en_media_substitutes_from_hash_map() {
        let mut res = HashMap::new();
        res.insert("abc123".into(), "![](img-1.png)".into());
        let md = enml_to_markdown(
            r#"<en-note><p>See <en-media hash="abc123" type="image/png"/> here</p></en-note>"#,
            &res,
        )
        .unwrap();
        assert_eq!(md, "See ![](img-1.png) here");
    }

    #[test]
    fn en_media_missing_hash_leaves_placeholder() {
        let md = convert(
            r#"<en-note><p>X <en-media hash="deadbeef" type="image/png"/> Y</p></en-note>"#,
        );
        assert!(md.contains("[missing attachment: deadbeef"));
    }

    #[test]
    fn pre_code_block_preserves_content_verbatim() {
        let md = convert("<en-note><pre>fn main() {\n  println!(\"hi\");\n}</pre></en-note>");
        assert!(md.starts_with("```\n"));
        assert!(md.contains("fn main()"));
        assert!(md.trim_end().ends_with("```"));
        // No markdown-escaping inside the fence.
        assert!(!md.contains("\\!"));
    }

    #[test]
    fn inline_code_uses_backticks() {
        let md = convert("<en-note><p>Use <code>foo()</code> here</p></en-note>");
        assert_eq!(md, "Use `foo()` here");
    }

    #[test]
    fn blockquote_prefix() {
        let md = convert("<en-note><blockquote><p>Quoted</p></blockquote></en-note>");
        assert!(md.contains("> Quoted"), "got: {md:?}");
    }

    #[test]
    fn img_with_src_becomes_markdown_image() {
        let md = convert(r#"<en-note><p><img src="https://x/y.png" alt="cat"/></p></en-note>"#);
        assert_eq!(md, "![cat](https://x/y.png)");
    }

    #[test]
    fn simple_table_becomes_pipe_table() {
        let md = convert(
            "<en-note><table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table></en-note>",
        );
        assert!(md.contains("| A | B |"));
        assert!(md.contains("| --- | --- |"));
        assert!(md.contains("| 1 | 2 |"));
    }

    #[test]
    fn empty_table_is_silently_dropped() {
        let md = convert("<en-note><table></table></en-note>");
        assert_eq!(md, "");
    }

    #[test]
    fn markdown_specials_in_text_are_escaped() {
        let md = convert("<en-note><p>Use *asterisks* and _underscores_</p></en-note>");
        assert!(md.contains("\\*asterisks\\*"));
        assert!(md.contains("\\_underscores\\_"));
    }

    #[test]
    fn anchor_becomes_markdown_link() {
        let md = convert(r#"<en-note><p>See <a href="https://example.com">site</a></p></en-note>"#);
        assert_eq!(md, "See [site](https://example.com)");
    }

    #[test]
    fn html_named_entities_do_not_fail_the_note() {
        let md = convert(
            "<en-note><p>a&nbsp;b &mdash; c&hellip; &copy;2026 &ldquo;q&rdquo; 5&deg;C &euro;9</p></en-note>",
        );
        assert_eq!(md, "a\u{a0}b — c… ©2026 “q” 5°C €9");
    }

    #[test]
    fn numeric_entities_decode_and_unknown_entities_stay_literal() {
        let md = convert("<en-note><p>&#169; &#xA9; &bogus; AT&amp;T &amp</p></en-note>");
        assert_eq!(md, "© © &bogus; AT&T &amp");
    }

    #[test]
    fn decode_entities_covers_required_set() {
        for (name, ch) in [
            ("nbsp", '\u{a0}'),
            ("amp", '&'),
            ("lt", '<'),
            ("gt", '>'),
            ("quot", '"'),
            ("apos", '\''),
            ("copy", '©'),
            ("reg", '®'),
            ("trade", '™'),
            ("hellip", '…'),
            ("mdash", '—'),
            ("ndash", '–'),
            ("lsquo", '‘'),
            ("rsquo", '’'),
            ("ldquo", '“'),
            ("rdquo", '”'),
            ("bull", '•'),
            ("middot", '·'),
            ("times", '×'),
            ("divide", '÷'),
            ("deg", '°'),
            ("plusmn", '±'),
            ("euro", '€'),
            ("pound", '£'),
            ("yen", '¥'),
            ("cent", '¢'),
            ("sect", '§'),
            ("para", '¶'),
            ("laquo", '«'),
            ("raquo", '»'),
            ("iexcl", '¡'),
            ("iquest", '¿'),
            ("shy", '\u{ad}'),
            ("zwj", '\u{200d}'),
            ("zwnj", '\u{200c}'),
            ("ensp", '\u{2002}'),
            ("emsp", '\u{2003}'),
            ("thinsp", '\u{2009}'),
        ] {
            assert_eq!(
                decode_entities(&format!("&{name};")),
                ch.to_string(),
                "{name}"
            );
        }
        assert_eq!(decode_entities("&#0;"), "\u{FFFD}");
        assert_eq!(decode_entities("&#x110000;"), "\u{FFFD}");
    }

    #[test]
    fn entities_in_attributes_are_decoded() {
        let md = convert(
            r#"<en-note><p><a href="https://x.test/?a=1&amp;b=2&nbsp;c">go</a></p></en-note>"#,
        );
        assert_eq!(md, "[go](https://x.test/?a=1&b=2%C2%A0c)");
    }

    #[test]
    fn dangerous_link_schemes_are_dropped_but_text_kept() {
        for href in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            " java\tscript:alert(1)",
            "vbscript:msgbox",
            "data:text/html;base64,PHNjcmlwdD4=",
        ] {
            let md = convert(&format!(
                r#"<en-note><p><a href="{href}">click</a></p></en-note>"#
            ));
            assert_eq!(md, "click", "href {href:?}");
        }
    }

    #[test]
    fn anchor_without_href_emits_plain_text() {
        let md = convert(r#"<en-note><p><a name="top">here</a></p></en-note>"#);
        assert_eq!(md, "here");
    }

    #[test]
    fn link_urls_are_escaped_for_markdown() {
        let md = convert(r#"<en-note><p><a href="https://x.test/a b(c)<d>">t</a></p></en-note>"#);
        assert_eq!(md, "[t](https://x.test/a%20b%28c%29%3Cd%3E)");
        let md = convert("<en-note><p><a href=\"https://x.test/a&#10;b\">t</a></p></en-note>");
        assert_eq!(md, "[t](https://x.test/a%0Ab)");
    }

    #[test]
    fn image_sources_are_sanitized() {
        let md = convert(r#"<en-note><p><img src="javascript:alert(1)" alt="x"/></p></en-note>"#);
        assert_eq!(md, "");
        let md = convert(
            r#"<en-note><p><img src="data:image/svg+xml;base64,AAAA" alt="x"/></p></en-note>"#,
        );
        assert_eq!(md, "");
        let md = convert(
            r#"<en-note><p><img src="data:image/png;base64,AAAA" alt="a]b"/></p></en-note>"#,
        );
        assert_eq!(md, "![a\\]b](data:image/png;base64,AAAA)");
        let md = convert(r#"<en-note><p><img src="pics/my cat (1).png" alt="c"/></p></en-note>"#);
        assert_eq!(md, "![c](pics/my%20cat%20%281%29.png)");
    }

    #[test]
    fn missing_attachment_placeholder_escapes_attribute_values() {
        let md = convert(
            r#"<en-note><p><en-media hash="x](javascript:alert(1))" type="image/png"/></p></en-note>"#,
        );
        assert_eq!(
            md, "[missing attachment: x\\](javascript:alert(1)) (image/png)]",
            "the injected ']' must be escaped"
        );
    }

    #[test]
    fn sanitize_url_keeps_relative_paths_with_colons() {
        assert_eq!(
            sanitize_url("notes/a:b.md").as_deref(),
            Some("notes/a:b.md")
        );
        assert_eq!(sanitize_url("   ").as_deref(), None);
        assert_eq!(
            sanitize_url("mailto:me@example.com").as_deref(),
            Some("mailto:me@example.com")
        );
    }

    #[test]
    fn nested_lists_indent() {
        let md = convert("<en-note><ul><li>parent<ul><li>child</li></ul></li></ul></en-note>");
        // We don't insist on perfect spacing, just that the child is
        // indented by two spaces.
        assert!(md.contains("- parent"));
        assert!(md.contains("  - child"), "got: {md:?}");
    }
}
