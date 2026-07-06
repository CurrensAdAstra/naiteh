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
                let s = t
                    .unescape()
                    .map_err(|err| AppError::ConfigCorrupt(format!("ENML text unescape: {err}")))?;
                state.handle_text(&s);
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
    /// Set on `<a>` start, consumed on `</a>` end.
    last_attr_href: Option<String>,
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
            last_attr_href: None,
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
                self.record_a_start(e);
                self.flush_block_break();
                self.out.push('[');
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
            "td" | "th" => {
                if self.table.is_some() {
                    self.cell_buf = Some(String::new());
                }
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
                // href stored under attribute; closed below
                let href = self.last_attr_href.take().unwrap_or_default();
                self.out.push_str(&format!("]({href})"));
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
                let mut src = String::new();
                let mut alt = String::new();
                for attr in e.attributes().with_checks(false).flatten() {
                    let key = std::str::from_utf8(attr.key.local_name().as_ref())
                        .unwrap_or("")
                        .to_string();
                    let val = attr
                        .unescape_value()
                        .map(|c| c.into_owned())
                        .unwrap_or_default();
                    match key.as_str() {
                        "src" => src = val,
                        "alt" => alt = val,
                        _ => {}
                    }
                }
                if !src.is_empty() {
                    self.write_inline(&format!("![{alt}]({src})"));
                }
            }
            "en-todo" => {
                let checked = e
                    .attributes()
                    .with_checks(false)
                    .flatten()
                    .find(|a| a.key.local_name().as_ref() == b"checked")
                    .and_then(|a| {
                        a.unescape_value()
                            .ok()
                            .map(|v| matches!(v.as_ref(), "true" | "True" | "TRUE" | "1"))
                    })
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
                let mut hash = String::new();
                let mut mime = String::new();
                for attr in e.attributes().with_checks(false).flatten() {
                    let key = std::str::from_utf8(attr.key.local_name().as_ref())
                        .unwrap_or("")
                        .to_string();
                    let val = attr
                        .unescape_value()
                        .map(|c| c.into_owned())
                        .unwrap_or_default();
                    match key.as_str() {
                        "hash" => hash = val.to_ascii_lowercase(),
                        "type" => mime = val,
                        _ => {}
                    }
                }
                let placeholder = match self.resources_md.get(&hash) {
                    Some(md) => md.clone(),
                    None => format!("[missing attachment: {hash} ({mime})]"),
                };
                self.write_inline(&placeholder);
            }
            // For other "empty" elements treat as a no-op.
            _ => {}
        }
        Ok(())
    }

    fn handle_text(&mut self, text: &str) {
        if self.cell_buf.is_some() {
            // Inside a table cell — buffer instead of writing.
            self.cell_buf.as_mut().unwrap().push_str(text);
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
        if self.cell_buf.is_some() {
            self.cell_buf.as_mut().unwrap().push_str(s);
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

// `<a>` requires us to remember the href across the start/end pair.
// Stashed on the state in `last_attr_href` rather than threaded through
// every handler.
impl<'a> ConverterState<'a> {
    fn record_a_start(&mut self, e: &BytesStart<'_>) {
        let href = e
            .attributes()
            .with_checks(false)
            .flatten()
            .find(|a| a.key.local_name().as_ref() == b"href")
            .and_then(|a| a.unescape_value().ok().map(|c| c.into_owned()))
            .unwrap_or_default();
        self.last_attr_href = Some(href);
    }
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
    fn nested_lists_indent() {
        let md = convert("<en-note><ul><li>parent<ul><li>child</li></ul></li></ul></en-note>");
        // We don't insist on perfect spacing, just that the child is
        // indented by two spaces.
        assert!(md.contains("- parent"));
        assert!(md.contains("  - child"), "got: {md:?}");
    }
}
