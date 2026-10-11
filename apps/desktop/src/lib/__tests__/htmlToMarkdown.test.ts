import { describe, expect, it } from "vitest";

import {
  clipboardToText,
  escapeLineStart,
  escapeText,
  htmlHasFormatting,
  htmlToMarkdown,
  sanitizeHtml,
} from "../htmlToMarkdown";
import { DEFAULT_CLIPPING, type ClippingConfig } from "../types";

function md(html: string, over: Partial<ClippingConfig> = {}): string {
  return htmlToMarkdown(html, { ...DEFAULT_CLIPPING, ...over });
}

/** Minimal DataTransfer stand-in (jsdom has none). */
function fakeClipboard(
  flavours: Record<string, string>,
  files: File[] = [],
): DataTransfer {
  const items = [
    ...Object.entries(flavours).map(([type]) => ({
      kind: "string",
      type,
      getAsFile: () => null,
    })),
    ...files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
  ];
  return {
    getData: (t: string) => flavours[t] ?? "",
    items,
    types: [...Object.keys(flavours), ...(files.length > 0 ? ["Files"] : [])],
    files,
  } as unknown as DataTransfer;
}

describe("htmlToMarkdown: blocks", () => {
  it("converts headings in atx style", () => {
    expect(md("<h1>One</h1><h2>Two</h2><h3>Three</h3><h6>Six</h6>")).toBe(
      "# One\n\n## Two\n\n### Three\n\n###### Six",
    );
  });

  it("converts h1/h2 in setext style and keeps atx for h3+", () => {
    expect(md("<h1>Title</h1><h2>Sub</h2><h3>Deep</h3>", { headingStyle: "setext" })).toBe(
      "Title\n=====\n\nSub\n---\n\n### Deep",
    );
  });

  it("does not double-bold styled spans inside headings", () => {
    expect(md('<h1><span style="font-weight:700">Bold title</span></h1>')).toBe(
      "# Bold title",
    );
  });

  it("separates paragraphs by exactly one blank line", () => {
    expect(md("<p>a</p>\n\n\n<p></p><div><p>b</p></div>")).toBe("a\n\nb");
  });

  it("collapses whitespace like a browser", () => {
    expect(md("<p>  hello \n\t  <b> big </b>   world  </p>")).toBe(
      "hello **big** world",
    );
  });

  it("renders <br> as a hard break", () => {
    expect(md("<p>line one<br>line two<br><br></p>")).toBe(
      "line one\\\nline two",
    );
  });

  it("renders hr", () => {
    expect(md("<p>a</p><hr><p>b</p>")).toBe("a\n\n---\n\nb");
  });

  it("converts nested blockquotes", () => {
    expect(
      md("<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>"),
    ).toBe("> outer\n>\n> > inner");
  });

  it("treats div/section/article/span as containers", () => {
    expect(
      md("<section><article><div>one</div><div><span>two</span></div></article></section>"),
    ).toBe("one\n\ntwo");
  });
});

describe("htmlToMarkdown: inline", () => {
  it("uses the configured emphasis and strong markers", () => {
    const html = "<p><em>it</em> <strong>bo</strong> <i>i2</i> <b>b2</b></p>";
    expect(md(html)).toBe("_it_ **bo** _i2_ **b2**");
    expect(md(html, { emphasis: "*", strong: "__" })).toBe("*it* __bo__ *i2* __b2__");
  });

  it("converts strike-through", () => {
    expect(md("<p><del>a</del> <s>b</s> <strike>c</strike></p>")).toBe(
      "~~a~~ ~~b~~ ~~c~~",
    );
  });

  it("does not nest the same marker twice", () => {
    expect(md("<p><b>a <strong>b</strong> c</b></p>")).toBe("**a b c**");
  });

  it("keeps edge whitespace outside emphasis and drops empty emphasis", () => {
    expect(md("<p>a<em> b </em>c<strong> </strong>d</p>")).toBe("a _b_ c d");
  });

  it("fences inline code around backticks inside", () => {
    expect(md("<p><code>a</code></p>")).toBe("`a`");
    expect(md("<p><code>a`b</code></p>")).toBe("``a`b``");
    expect(md("<p><code>`tick`</code></p>")).toBe("`` `tick` ``");
    expect(md("<p><code>x``y`z</code></p>")).toBe("```x``y`z```");
  });

  it("does not escape inside inline code", () => {
    expect(md("<p><code>*a_b* [c]</code></p>")).toBe("`*a_b* [c]`");
  });

  it("passes sup/sub through as inline HTML", () => {
    expect(md("<p>x<sup>2</sup> H<sub>2</sub>O</p>")).toBe(
      "x<sup>2</sup> H<sub>2</sub>O",
    );
  });
});

describe("htmlToMarkdown: escaping", () => {
  it("escapes inline formatting characters in text", () => {
    expect(md("<p>2 * 3 = [six] `x` _y_ snake_case</p>")).toBe(
      "2 \\* 3 = \\[six\\] \\`x\\` \\_y\\_ snake_case",
    );
  });

  it("escapes block markers at the start of a line", () => {
    expect(md("<p># not a heading</p>")).toBe("\\# not a heading");
    expect(md("<p>&gt; not a quote</p>")).toBe("\\> not a quote");
    expect(md("<p>- not a list</p>")).toBe("\\- not a list");
    expect(md("<p>+ not a list</p>")).toBe("\\+ not a list");
    expect(md("<p>* not a list</p>")).toBe("\\* not a list");
    expect(md("<p>1. not ordered</p>")).toBe("1\\. not ordered");
    expect(md("<p>a<br>---</p>")).toBe("a\\\n\\---");
  });

  it("leaves #tags and mid-line markers alone", () => {
    expect(md("<p>#tag and 1. and - here</p>")).toBe("#tag and 1. and - here");
  });

  it("escapes HTML-looking text and entities", () => {
    expect(md("<p>&lt;div&gt; &amp;amp; a &lt; b</p>")).toBe(
      "\\<div> \\&amp; a < b",
    );
  });

  it("escapes backslashes before punctuation only", () => {
    expect(escapeText("C:\\Users \\*")).toBe("C:\\Users \\\\\\*");
  });

  it("escapeLineStart handles numbered and setext-looking lines", () => {
    expect(escapeLineStart("2024) year")).toBe("2024\\) year");
    expect(escapeLineStart("===")).toBe("\\===");
    expect(escapeLineStart("plain")).toBe("plain");
  });
});

describe("htmlToMarkdown: lists", () => {
  it("converts nested unordered lists with each bullet marker", () => {
    const html = "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>";
    expect(md(html)).toBe("- a\n  - b\n    - c\n- d");
    expect(md(html, { bulletMarker: "*" })).toBe("* a\n  * b\n    * c\n* d");
    expect(md(html, { bulletMarker: "+" })).toBe("+ a\n  + b\n    + c\n+ d");
  });

  it("numbers ordered lists from start and indents under the marker", () => {
    const html =
      '<ol start="9"><li>nine</li><li>ten<ul><li>sub</li></ul></li></ol>';
    expect(md(html)).toBe("9. nine\n10. ten\n    - sub");
  });

  it("handles paragraphs and code inside list items", () => {
    const html =
      "<ul><li><p>first</p><p>second</p><pre><code>x = 1</code></pre></li></ul>";
    expect(md(html)).toBe("- first\n\n  second\n\n  ```\n  x = 1\n  ```");
  });

  it("keeps Google-Docs style <li><p> lists tight", () => {
    expect(md("<ul><li><p>a</p></li><li><p>b</p></li></ul>")).toBe("- a\n- b");
  });

  it("attaches a list nested directly in a list to the previous item", () => {
    expect(md("<ul><li>a</li><ul><li>b</li></ul></ul>")).toBe("- a\n  - b");
  });

  it("converts task-list checkboxes", () => {
    const html =
      '<ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox"> todo</li></ul>';
    expect(md(html)).toBe("- [x] done\n- [ ] todo");
  });

  it("escapes list-like text inside items", () => {
    expect(md("<ol><li>1. odd</li></ol>")).toBe("1. 1\\. odd");
  });
});

describe("htmlToMarkdown: code blocks", () => {
  const html =
    '<pre><code class="language-ts">const a = 1;\n\n  if (a) {}\n</code></pre>';

  it("fences with the language from the class", () => {
    expect(md(html)).toBe("```ts\nconst a = 1;\n\n  if (a) {}\n```");
    expect(md('<pre class="lang-py"><code>x</code></pre>')).toBe("```py\nx\n```");
  });

  it("indents when configured", () => {
    expect(md(html, { codeBlockStyle: "indented" })).toBe(
      "    const a = 1;\n\n      if (a) {}",
    );
  });

  it("lengthens the fence around backtick runs", () => {
    expect(md("<pre>```\ninner\n```</pre>")).toBe("````\n```\ninner\n```\n````");
  });

  it("keeps <br> in pre as newlines and does not escape", () => {
    expect(md("<pre>a * b<br>_c_</pre>")).toBe("```\na * b\n_c_\n```");
  });
});

describe("htmlToMarkdown: links and images", () => {
  it("renders inline links with titles", () => {
    expect(md('<p><a href="https://x.dev/a b" title="T &quot;q&quot;">go</a></p>')).toBe(
      '[go](https://x.dev/a%20b "T \\"q\\"")',
    );
  });

  it("leaves relative URLs as is and autolinks bare URLs", () => {
    expect(md('<p><a href="../doc.html#s">doc</a></p>')).toBe("[doc](../doc.html#s)");
    expect(md('<p><a href="https://x.dev">https://x.dev</a></p>')).toBe(
      "<https://x.dev>",
    );
  });

  it("drops javascript: hrefs, keeping the text", () => {
    expect(md('<p><a href="javascript:alert(1)">click</a></p>')).toBe("click");
    expect(md('<p><a href=" JaVa\tScRiPt:alert(1)">x</a></p>')).toBe("x");
  });

  it("collects reference links at the end, deduplicated", () => {
    const html =
      '<p><a href="https://a.dev">A</a> and <a href="https://b.dev" title="B">B</a> and <a href="https://a.dev">again</a></p>';
    expect(md(html, { linkStyle: "reference" })).toBe(
      '[A][1] and [B][2] and [again][1]' +
        '\n\n[1]: https://a.dev\n[2]: https://b.dev "B"',
    );
  });

  it("keeps or drops images", () => {
    const html = '<p><img src="/i.png" alt="a [b]" title="t"> after</p>';
    expect(md(html)).toBe('![a \\[b\\]](/i.png "t") after');
    expect(md(html, { images: "drop" })).toBe("after");
  });

  it("handles linked images", () => {
    expect(md('<a href="/big"><img src="/s.png" alt="s"></a>')).toBe(
      "[![s](/s.png)](/big)",
    );
  });
});

describe("htmlToMarkdown: tables", () => {
  const html = `<table>
    <thead><tr><th>Name</th><th align="right">Qty</th></tr></thead>
    <tbody><tr><td>a|b</td><td>1</td></tr><tr><td><b>c</b></td><td>2<br>3</td></tr></tbody>
  </table>`;

  it("renders GFM pipe tables with escaped pipes and alignment", () => {
    expect(md(html)).toBe(
      [
        "| Name  | Qty    |",
        "| ----- | -----: |",
        "| a\\|b  | 1      |",
        "| **c** | 2<br>3 |",
      ].join("\n"),
    );
  });

  it("uses the first row as header when there is no thead", () => {
    expect(md("<table><tr><td>h1</td><td>h2</td></tr><tr><td>x</td></tr></table>")).toBe(
      "| h1  | h2  |\n| --- | --- |\n| x   |     |",
    );
  });

  it("keeps sanitized HTML tables", () => {
    const out = md(
      '<table class="x" onclick="evil()"><tr><td style="color:red">a</td><td>b</td></tr></table>',
      { tables: "html" },
    );
    expect(out).toBe("<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>");
  });

  it("renders tables as text rows", () => {
    expect(md(html, { tables: "text" })).toBe("Name · Qty\na|b · 1\n**c** · 2 3");
  });

  it("unwraps single-cell layout tables", () => {
    expect(md("<table><tr><td><p>just text</p></td></tr></table>")).toBe("just text");
  });
});

describe("htmlToMarkdown: cleaning", () => {
  it("strips scripts, styles, comments and other junk", () => {
    const html = `<html><head><meta charset="utf-8"><style>p{}</style></head><body>
      <!--StartFragment--><p>keep</p><script>alert(1)</script><noscript>no</noscript>
      <iframe src="x"></iframe><object>o</object><!--EndFragment--></body></html>`;
    expect(md(html)).toBe("keep");
  });

  it("drops hidden elements", () => {
    expect(
      md('<p>a<span hidden>h</span><span aria-hidden="true">x</span><span style="display: none">y</span>b</p>'),
    ).toBe("ab");
  });

  it("strips the Windows CF_HTML header", () => {
    expect(
      md("Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000200\r\n<html><body><p><b>x</b></p></body></html>"),
    ).toBe("**x**");
  });

  it("does not bold the Google Docs wrapper but honours styled spans", () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-abc"><h2 dir="ltr"><span>Title</span></h2><p dir="ltr"><span style="font-weight:700">Bold</span><span> and </span><span style="font-style:italic">it</span><span style="text-decoration:line-through">x</span></p><ul><li dir="ltr"><p dir="ltr"><span>item</span></p></li></ul></b><br>';
    expect(md(html)).toBe("## Title\n\n**Bold** and _it_~~x~~\n\n- item");
  });
});

describe("sanitizeHtml", () => {
  it("removes scripts, handlers and javascript: URLs but keeps markup", () => {
    const out = sanitizeHtml(
      '<p onclick="x()" class="c">hi <a href="javascript:alert(1)">a</a> <a href="/ok">b</a><img src="x" onerror="bad()"></p><script>bad()</script><style>p{}</style>',
    );
    expect(out).toBe('<p class="c">hi <a>a</a> <a href="/ok">b</a><img src="x"></p>');
  });

  it("drops blank lines so the HTML block stays contiguous", () => {
    expect(sanitizeHtml("<div>a</div>\n\n\n<div>b</div>")).toBe("<div>a</div>\n<div>b</div>");
  });
});

describe("clipboardToText", () => {
  const rich = "<p>Hello <b>world</b></p>";

  it("returns null when HTML pasting is set to plain", () => {
    const data = fakeClipboard({ "text/html": rich, "text/plain": "Hello world" });
    expect(clipboardToText(data, { ...DEFAULT_CLIPPING, htmlPaste: "plain" })).toBeNull();
  });

  it("returns null without text/html", () => {
    expect(clipboardToText(fakeClipboard({ "text/plain": "x" }), DEFAULT_CLIPPING)).toBeNull();
  });

  it("converts formatted HTML to Markdown", () => {
    const data = fakeClipboard({ "text/html": rich, "text/plain": "Hello world" });
    expect(clipboardToText(data, DEFAULT_CLIPPING)).toBe("Hello **world**");
  });

  it("prefers text/plain for formatting-free HTML wrappers", () => {
    const data = fakeClipboard({
      "text/html": '<div style="color:#333"><div><span>const x = 1;</span></div></div>',
      "text/plain": "const x = 1;",
    });
    expect(clipboardToText(data, DEFAULT_CLIPPING)).toBeNull();
    expect(
      clipboardToText(
        fakeClipboard({
          "text/html": '<b style="font-weight:normal" id="docs-internal-guid-1"><p>plain</p></b>',
        }),
        DEFAULT_CLIPPING,
      ),
    ).toBeNull();
  });

  it("returns sanitized HTML in html mode", () => {
    const data = fakeClipboard({ "text/html": '<p onclick="x()">a</p><script>1</script>' });
    expect(clipboardToText(data, { ...DEFAULT_CLIPPING, htmlPaste: "html" })).toBe("<p>a</p>");
  });

  it("htmlHasFormatting detects links and styled spans", () => {
    expect(htmlHasFormatting('<a href="/x">x</a>')).toBe(true);
    expect(htmlHasFormatting('<a href="javascript:void(0)">x</a>')).toBe(false);
    expect(htmlHasFormatting('<span style="font-weight: bold">x</span>')).toBe(true);
    expect(htmlHasFormatting("<p>a</p><p>b</p>")).toBe(false);
  });
});
