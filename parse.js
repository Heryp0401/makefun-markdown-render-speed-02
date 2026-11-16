// parse.js — fast CommonMark 0.31.2 + GFM 0.29 renderer, byte-compatible with
// marked 18.1.3 (default options, GFM on). No dependencies.
// Architecture: normalize -> split lines -> block tokenizer (collects link ref
// defs) -> block renderer -> inline parser (delimiter stack) per text block.
// The tokenizer runs over the whole document first so forward link references
// resolve, exactly like marked.

export function parse(src) {
  const norm = src.replace(/\r\n?/g, '\n');
  HTML_ENDS_NL = norm.endsWith('\n');
  inAnchor = false;
  const raw = norm.split('\n');
  // Drop a single trailing empty line produced by a trailing newline: it is
  // just the end of the last line, not an extra blank line.
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  // Each line is {s: text, f: strip4 flag}. f=1 means: if this line continues
  // a paragraph inside a container, strip 4 leading spaces when its indent
  // is >= 4 (the "indented code position" rule for lazy/container lines).
  const lines = raw.map(s => ({ s, f: 0 }));
  const refs = new Map();
  const { tokens } = blockTokens(lines, 0, lines.length, refs);
  const out = [];
  renderBlocks(tokens, refs, out);
  return out.join('');
}

// ---------------------------------------------------------------- helpers
// Set by parse(): whether the (normalized) input ends with a newline. An
// HTML block ending at EOF keeps that trailing newline.
let HTML_ENDS_NL = false;
// Inside a raw <a>...</a> element: bare URLs are not autolinked there (no
// nested anchors). This persists across blocks within a document: an
// unclosed inline <a> in one paragraph suppresses autolinks in later
// paragraphs until a </a> appears. Reset per document in parse().
let inAnchor = false;

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Leading indent of a line in columns (tab = next multiple of 4) and the
// index where non-whitespace content starts. Returns [cols, idx].
function indentOf(s) {
  let col = 0, i = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col & 3);
    else break;
  }
  return [col, i];
}

// Remove up to n columns of leading indent; a tab straddling the boundary
// becomes spaces. Returns the remaining string.
// Remove up to n columns of leading indent. The leading whitespace is
// expanded to spaces on the ORIGINAL columns first, so that a tab
// straddling the cut (or a tab after it) keeps its correct width for
// downstream column math. Tabs inside the content are untouched.
function stripIndent(s, n) {
  // Remove the first n columns of leading indentation. A tab that
  // straddles the cut becomes spaces for the part past the cut; a tab
  // entirely past the cut is kept as a literal tab. Used for code blocks.
  let col = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      if (col >= n) break;
      col++;
      i++;
    } else if (c === 9) {
      const w = 4 - (col & 3);
      if (col >= n) break; // tab entirely past the cut: keep it
      if (col + w <= n) { col += w; i++; continue; }
      // tab straddles the cut: remainder becomes spaces
      return ' '.repeat(col + w - n) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

// Column-based strip for container (list item) indentation: expand the
// leading whitespace to spaces on the original columns, then drop the
// first n columns. A tab at/past the cut becomes spaces (its width from
// its original column). With n === 0 the line is returned verbatim.
function stripColumns(s, n) {
  if (n === 0) return s;
  let col = 0;
  let i = 0;
  let spaces = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { spaces += ' '; col++; i++; }
    else if (c === 9) { const w = 4 - (col & 3); spaces += ' '.repeat(w); col += w; i++; }
    else break;
  }
  if (col <= n) return s.slice(i);
  return spaces.slice(n) + s.slice(i);
}

// HTML-escape code content: & < > " ' are always escaped (no entity logic).
function escapeHtml(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// Escape an attribute value (href/title/alt): & is escaped unless it starts
// a valid entity (&word; or &#...; / &#x...;), which passes through as-is.
// Numeric entities are NOT decoded here.
function escapeAttr(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      const e = entityEnd(s, i);
      if (e > 0) { i = e - 1; continue; }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// If s[i] === '&' and an entity starts there, return the index just past the
// ';' (entityEnd > i), else 0. Accepts &word; (word = [A-Za-z0-9_]+) and
// numeric &#digits; / &#x hex; (digits must be present and valid).
function entityEnd(s, i) {
  const n = s.length;
  if (i + 1 >= n) return 0;
  let j = i + 1;
  if (s.charCodeAt(j) === 35) { // '#'
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { // x/X
      j++;
      const st = j;
      while (j < n) {
        const c = s.charCodeAt(j);
        if ((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)) j++;
        else break;
      }
      // hex numeric entity: 1-6 digits (0x10FFFF is 6 digits)
      if (j === st || j - st > 6) return 0;
    } else {
      const st = j;
      while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
      // decimal numeric entity: 1-7 digits (1114111 is 7 digits)
      if (j === st || j - st > 7) return 0;
    }
    if (j < n && s.charCodeAt(j) === 59) return j + 1;
    return 0;
  }
  const st = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j === st) return 0;
  if (j < n && s.charCodeAt(j) === 59) return j + 1;
  return 0;
}

// Decode a numeric entity starting at s[i] ('&'). Returns [endIndex, char]
// or null if it is not a valid numeric entity. Invalid code points
// (0, surrogates, > 0x10FFFF) decode to U+FFFD.
function decodeNumericEntity(s, i) {
  const n = s.length;
  let j = i + 2; // skip '&#'
  let hex = false;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
  const st = j;
  let cp = 0;
  let overflow = false;
  while (j < n) {
    const c = s.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    else break;
    if (!overflow) {
      cp = cp * (hex ? 16 : 10) + d;
      if (cp > 0x10FFFF) overflow = true;
    }
    j++;
  }
  if (j === st) return null;
  if (j >= n || s.charCodeAt(j) !== 59) return null;
  if (overflow || cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF)) return [j + 1, '\uFFFD'];
  return [j + 1, String.fromCodePoint(cp)];
}

// Resolve backslash escapes (\X -> X for ASCII punctuation X) in a link
// destination or title.
function unescapeBackslash(s) {
  if (s.indexOf('\\') < 0) return s;
  let r = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) { r += s[i + 1]; i += 2; }
    else { r += s[i]; i++; }
  }
  return r;
}

// Percent-encode non-ASCII chars (UTF-8) in a URL href. ASCII is left
// as-is (so existing %XX sequences are not double-encoded).
function encodeNonAscii(s) {
  let hasNonAscii = false;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) { hasNonAscii = true; break; }
  if (!hasNonAscii) return s;
  let r = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 127) { r += s[i]; continue; }
    let ch = s[i];
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) { ch = s.slice(i, i + 2); i++; }
    }
    r += encodeURIComponent(ch);
  }
  return r;
}

function isSpaceCode(c) {
  if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) return true;
  // Unicode whitespace: NBSP and other space/line/paragraph separators
  return c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8239 || c === 8287 || c === 12288 || c === 8232 || c === 8233;
}

const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
function isPunctCode(c) {
  if (c < 128) return ASCII_PUNCT.indexOf(String.fromCharCode(c)) >= 0;
  // CommonMark "punctuation" = Unicode categories P (punctuation) or S (symbol)
  return PUNCT_RE.test(String.fromCharCode(c));
}
const PUNCT_RE = /[\p{P}\p{S}]/u;

function isAsciiPunct(c) {
  return c < 128 && ASCII_PUNCT.indexOf(String.fromCharCode(c)) >= 0;
}

// Normalize a link label: unescape backslash escapes, collapse whitespace
// runs to one space, trim, lowercase.
function normalizeLabel(label) {
  // Case-fold + collapse whitespace. Backslash escapes are NOT resolved
  // for matching (a label foo\! does not match foo!). Unicode case
  // folding maps ß/ẞ to ss.
  let out = '';
  let inWs = true; // trim leading
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    if (isSpaceCode(c)) {
      if (!inWs) { out += ' '; inWs = true; }
    } else {
      out += label[i];
      inWs = false;
    }
  }
  if (out.length > 0 && out.charCodeAt(out.length - 1) === 32) out = out.slice(0, -1);
  return out.replace(/ß|ẞ/g, 'ss').toLowerCase();
}

// ------------------------------------------------- link reference defs
// Try to parse a link reference definition starting at lines[i]. A def is:
//   [label]: <dest> "title"     (dest and title may each be on a following
//   line). Returns {label, dest, title, next} (next = index past the def)
//   or null.
function parseLinkRefDef(lines, i, n) {
  const line = lines[i].s;
  const [, ci] = indentOf(line);
  if (ci >= 4) return null;
  const s = line.slice(ci);
  if (s.charCodeAt(0) !== 91) return null; // '['
  // label: [ ... ] with no unescaped [ or ], non-empty, <= 999 chars.
  // The label may span lines; the ':' follows the ']' on its line.
  const labelParts = [];
  let labLine = i, labStr = s, labPos = 1;
  let labelEndLine = -1, labelEndPos = -1;
  outer: while (true) {
    while (labPos < labStr.length) {
      const c = labStr.charCodeAt(labPos);
      if (c === 92 && labPos + 1 < labStr.length) { labelParts.push(labStr[labPos], labStr[labPos + 1]); labPos += 2; continue; }
      if (c === 91) return null; // '[' inside label
      if (c === 93) { labelEndLine = labLine; labelEndPos = labPos; break outer; }
      labelParts.push(labStr[labPos]);
      labPos++;
    }
    if (labLine + 1 >= n) return null;
    const nl = lines[labLine + 1].s;
    if (isBlankLine(nl)) return null;
    labelParts.push('\n');
    labLine++;
    labStr = nl;
    labPos = 0;
  }
  const rawLabel = labelParts.join('');
  if (rawLabel.length === 0 || rawLabel.length > 999) return null;
  if (normalizeLabel(rawLabel).length === 0) return null; // whitespace-only label is not a def
  const endRaw = lines[labelEndLine].s;
  const endPosInRaw = labelEndLine === i ? ci + labelEndPos : labelEndPos;
  if (endPosInRaw + 1 >= endRaw.length || endRaw.charCodeAt(endPosInRaw + 1) !== 58) return null; // ':'
  // Position (line index, string, pos) of the destination.
  let cur = labelEndLine, curLine = endRaw, curPos = endPosInRaw + 2;
  const skipWs = () => {
    while (curPos < curLine.length && (curLine.charCodeAt(curPos) === 32 || curLine.charCodeAt(curPos) === 9)) curPos++;
  };
  skipWs();
  if (curPos >= curLine.length) {
    if (cur + 1 >= n) return null;
    const nl = lines[cur + 1].s;
    if (isBlankLine(nl)) return null;
    const [, nci] = indentOf(nl);
    cur++;
    curLine = nl.slice(nci);
    curPos = 0;
    skipWs();
    if (curPos >= curLine.length) return null;
  }
  // destination
  let dest = '';
  if (curLine.charCodeAt(curPos) === 60) { // '<' angle dest
    // Angle dest ends at a '>' that is followed by whitespace, end of line,
    // or end of the def (marked is lenient: it takes the last '>' that can
    // close it). We take the first '>' followed by ws/EOL; if none, the
    // last '>' on the line.
    let e = curPos + 1, closeAt = -1;
    while (e < curLine.length) {
      const c = curLine.charCodeAt(e);
      if (c === 62) {
        if (e + 1 >= curLine.length || curLine.charCodeAt(e + 1) === 32 || curLine.charCodeAt(e + 1) === 9) { closeAt = e; break; }
        closeAt = e; // candidate; keep looking for a better one
      }
      if (c === 60) return null; // '<' inside angle dest
      e++;
    }
    if (closeAt < 0) return null;
    dest = unescapeBackslash(curLine.slice(curPos + 1, closeAt)).replace(/\\/g, '%5C').replace(/ /g, '%20');
    curPos = closeAt + 1;
  } else {
    // bare dest: no spaces/control chars, balanced parens
    let e = curPos, depth = 0;
    while (e < curLine.length) {
      const c = curLine.charCodeAt(e);
      if (c === 32 || c === 9 || c < 32) break;
      if (c === 40) depth++;
      else if (c === 41) { if (depth === 0) break; depth--; }
      else if (c === 92 && e + 1 < curLine.length && isAsciiPunct(curLine.charCodeAt(e + 1))) { e += 2; continue; }
      e++;
    }
    if (e === curPos) return null;
    dest = unescapeBackslash(curLine.slice(curPos, e));
    dest = dest.replace(/\\/g, '%5C').replace(/</g, '%3C').replace(/>/g, '%3E');
    curPos = e;
  }
  // After dest: optional title (same line, next line, or spanning lines).
  // Skip spaces; if the line ends, the title may start on the next line.
  // A bad title on the SAME line invalidates the def; a bad/absent title
  // on a LATER line just means "no title" (the def is the dest alone).
  // A title directly after the dest with no whitespace is not a title.
  const destEnd = curPos;
  let p = curPos;
  while (p < curLine.length && (curLine.charCodeAt(p) === 32 || curLine.charCodeAt(p) === 9)) p++;
  let tLine = cur, tStr = curLine;
  const noTitle = () => ({ label: normalizeLabel(rawLabel), dest, title: null, next: cur + 1 });
  if (p >= tStr.length) {
    if (tLine + 1 >= n) return noTitle();
    const nl = lines[tLine + 1].s;
    if (isBlankLine(nl)) return noTitle();
    const [, nci] = indentOf(nl);
    tLine++;
    tStr = nl.slice(nci);
    p = 0;
    while (p < tStr.length && (tStr.charCodeAt(p) === 32 || tStr.charCodeAt(p) === 9)) p++;
    if (p >= tStr.length) return noTitle();
  }
  const q = tStr.charCodeAt(p);
  if (q !== 34 && q !== 39 && q !== 40) {
    if (tLine === cur) return null; // junk after dest on the same line
    return noTitle(); // next line is not a title: def is dest alone
  }
  if (tLine === cur && p === destEnd) return null; // title needs whitespace after dest
  const close = q === 40 ? 41 : q;
  // Find the closing quote, possibly across lines; title parts join with \n.
  const titleParts = [];
  let pos = p + 1;
  let cur2 = tLine, str2 = tStr;
  while (true) {
    let e = pos, found = -1;
    while (e < str2.length) {
      const c = str2.charCodeAt(e);
      if (c === 92 && e + 1 < str2.length) { e += 2; continue; }
      if (c === close) { found = e; break; }
      e++;
    }
    if (found >= 0) {
      titleParts.push(str2.slice(pos, found));
      let e2 = found + 1;
      while (e2 < str2.length && (str2.charCodeAt(e2) === 32 || str2.charCodeAt(e2) === 9)) e2++;
      if (e2 < str2.length) {
        if (tLine === cur) return null;
        return noTitle();
      }
      const title = titleParts.join('\n').replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
      return { label: normalizeLabel(rawLabel), dest, title, next: cur2 + 1 };
    }
    titleParts.push(str2.slice(pos));
    if (cur2 + 1 >= n) {
      if (tLine === cur) return null;
      return noTitle();
    }
    const nl = lines[cur2 + 1].s;
    if (isBlankLine(nl)) {
      if (tLine === cur) return null;
      return noTitle();
    }
    cur2++;
    str2 = nl;
    pos = 0;
  }
}

// ------------------------------------------------------- block tokenizer
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
const TYPE1_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

// A line (after <=3 spaces indent) that starts an HTML block. Returns the
// type (1..7) or 0. `s` is the content after the indent.
function htmlBlockType(s) {
  if (s.charCodeAt(0) !== 60) return 0; // '<'
  if (s.length < 2) return 0;
  const c1 = s.charCodeAt(1);
  if (c1 === 33) { // '!'
    if (s.startsWith('<!--')) return 2;
    if (s.startsWith('<![CDATA[')) return 5;
    if (s.length > 2 && s.charCodeAt(2) >= 65 && s.charCodeAt(2) <= 90) return 4; // <!A-Z
    if (s.length > 2 && s.charCodeAt(2) >= 97 && s.charCodeAt(2) <= 122) return 4; // <!a-z (doctype is uppercase but be lenient)
    return 0;
  }
  if (c1 === 63) return 3; // '<?'
  // tag name (open or close)
  let j = 1;
  const isClose = s.charCodeAt(j) === 47;
  if (isClose) j++; // '/'
  const nameStart = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (j === nameStart) return 0;
  const name = s.slice(nameStart, j).toLowerCase();
  // Type 1 is open tags only; </pre> etc. are not type 1 (and pre/script/
  // style/textarea are not in the type-6 list, so a close tag falls to 7).
  if (!isClose && TYPE1_TAGS.has(name)) return 1;
  if (BLOCK_TAGS.has(name)) return 6;
  // Type 7: any other complete tag alone on the line. The tag must be a
  // complete open/close tag (possibly with attributes) and nothing else.
  // A closing tag cannot have attributes.
  if (isClose) {
    let k = j;
    while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
    if (k < s.length && s.charCodeAt(k) === 62 && k === s.length - 1) return 7;
    return 0;
  }
  if (isCompleteTag(s, j)) return 7;
  return 0;
}

// After a tag name ending at index j in s, is the rest a complete tag
// (attributes + optional '/' + '>') with nothing after?
function isCompleteTag(s, j) {
  const n = s.length;
  let i = j;
  let sawWs = false; // whitespace seen since the tag name / last attribute
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 62) return i === n - 1; // '>' must be the last char
    if (c === 47) { // '/'
      if (i + 1 < n && s.charCodeAt(i + 1) === 62) return i + 1 === n - 1;
      return false;
    }
    if (c === 32 || c === 9) { sawWs = true; i++; continue; }
    // an attribute must be preceded by whitespace (so <a:b> is not a tag)
    if (!sawWs) return false;
    sawWs = false;
    // attribute name: [a-zA-Z_:][a-zA-Z0-9_.:-]*
    const c0 = s.charCodeAt(i);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95 || c0 === 58)) return false;
    i++;
    while (i < n) {
      const d = s.charCodeAt(i);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 45 || d === 46 || d === 58) i++;
      else break;
    }
    // optional = value
    while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) { i++; sawWs = true; }
    if (i < n && s.charCodeAt(i) === 61) {
      i++;
      while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
      if (i < n && (s.charCodeAt(i) === 34 || s.charCodeAt(i) === 39)) {
        const q = s.charCodeAt(i);
        i++;
        while (i < n && s.charCodeAt(i) !== q) i++;
        if (i >= n) return false;
        i++;
      } else {
        while (i < n) {
          const d = s.charCodeAt(i);
          if (d === 32 || d === 9 || d === 62 || d === 34 || d === 39 || d === 61 || d === 60 || d === 96) break;
          i++;
        }
      }
    }
  }
  return false;
}

function isThematicBreak(s) {
  // 3+ of -, _, * (same char), with optional spaces between, nothing else.
  let i = 0, ch = 0, count = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c === 45 || c === 95 || c === 42) {
      if (ch === 0) ch = c;
      else if (c !== ch) return false;
      count++;
      i++;
      continue;
    }
    return false;
  }
  return count >= 3;
}

function isAtxHeading(s) {
  // returns level 1-6 or 0
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6) return 0;
  if (i >= s.length) return i;
  const c = s.charCodeAt(i);
  if (c === 32 || c === 9) return i;
  return 0;
}

function fenceInfo(s) {
  // returns {ch, len, info} if s starts a fenced code block, else null
  const ch = s.charCodeAt(0);
  if (ch !== 96 && ch !== 126) return null;
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === ch) i++;
  if (i < 3) return null;
  const info = s.slice(i);
  if (ch === 96 && info.indexOf('`') >= 0) return null; // backtick in info
  return { ch, len: i, info };
}

function isFenceClose(s, ch, len) {
  if (s.charCodeAt(0) !== ch) return false;
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === ch) i++;
  if (i < len) return false;
  // only spaces after
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
    i++;
  }
  return true;
}

// Split a table row line into cells. Handles \| escapes and optional outer
// pipes. Returns null if the line has no pipe at all.
function splitTableRow(s) {
  if (s.indexOf('|') < 0) return null;
  let cells = [];
  let cur = '', i = 0;
  // strip leading pipe
  let start = 0, end = s.length;
  while (start < end && (s.charCodeAt(start) === 32 || s.charCodeAt(start) === 9)) start++;
  while (end > start && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  let body = s.slice(start, end);
  if (body.charCodeAt(0) === 124) body = body.slice(1);
  if (body.length > 0 && body.charCodeAt(body.length - 1) === 124) body = body.slice(0, -1);
  for (i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 92 && i + 1 < body.length && body.charCodeAt(i + 1) === 124) { cur += '|'; i++; continue; }
    if (c === 124) { cells.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  cells.push(cur);
  return cells.map(x => x.trim());
}

// Parse a delimiter row into alignments, or null if invalid.
function parseDelimRow(s) {
  const cells = splitTableRow(s);
  if (!cells) return null;
  const align = [];
  for (const cell of cells) {
    const t = cell;
    let left = false, right = false, k = 0;
    if (t.charCodeAt(0) === 58) { left = true; k = 1; }
    let dashes = 0;
    while (k < t.length && t.charCodeAt(k) === 45) { dashes++; k++; }
    if (dashes === 0) return null;
    if (k < t.length && t.charCodeAt(k) === 58) { right = true; k++; }
    if (k !== t.length) return null;
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : '');
  }
  return align;
}

// List marker at the start of s (content after <=3 indent). Returns
// {bullet: bool, ordered: bool, marker, start, contentCol, markerLen} or null.
function listMarker(s) {
  const c0 = s.charCodeAt(0);
  if (c0 === 45 || c0 === 43 || c0 === 42) { // - + *
    if (s.length === 1) return { bullet: true, marker: s[0], start: 0, markerLen: 1, contentCol: 1 };
    const c1 = s.charCodeAt(1);
    if (c1 === 32 || c1 === 9) return { bullet: true, marker: s[0], start: 0, markerLen: 1, contentCol: 1 };
    return null;
  }
  // ordered: 1-9 digits + . or )
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < s.length && i < 9 && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
    if (i === 0 || i > 9) return null;
    if (i >= s.length) return null;
    const d = s.charCodeAt(i);
    if (d !== 46 && d !== 41) return null; // '.' or ')'
    if (i + 1 >= s.length) return { bullet: false, marker: s.slice(0, i + 1), start: parseInt(s.slice(0, i), 10), markerLen: i + 1, contentCol: i + 1 };
    const c1 = s.charCodeAt(i + 1);
    if (c1 === 32 || c1 === 9) return { bullet: false, marker: s.slice(0, i + 1), start: parseInt(s.slice(0, i), 10), markerLen: i + 1, contentCol: i + 1 };
    return null;
  }
  return null;
}

// Absolute content column of a list item: the marker starts at column
// `indent` (0-3) at char index ci. Returns the column where the item's
// content starts (or would start, for an empty item).
function itemContentIndent(line, ci, indent, m) {
  // column just after the marker
  let col = indent + m.markerLen;
  let i = ci + m.markerLen;
  let spaces = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { spaces++; col++; i++; }
    else if (c === 9) { const w = 4 - (col & 3); spaces += w; col += w; i++; }
    else break;
  }
  if (spaces === 0) return indent + m.markerLen + 1; // empty item
  if (i >= line.length) return indent + m.markerLen + 1; // spaces only, empty item
  if (spaces >= 5) return indent + m.markerLen + 1;
  return col;
}

// ------------------------------------------------------- block tokenizer
// Classify an inner content line (content after <=3 indent) for lazy
// continuation tracking. Returns:
//   'para'  - paragraph text / continuation
//   'block' - a block that does not contain an open paragraph
//   'para-block' - a block (list item / nested quote) that may contain an
//                  open paragraph (its first line has content)
//   'blank' - blank line
function innerLineKind(s, openPara) {
  if (s.length === 0) return 'blank';
  const c0 = s.charCodeAt(0);
  if (c0 === 35 && isAtxHeading(s)) return 'block'; // ATX
  if (c0 === 96 || c0 === 126) { if (fenceInfo(s)) return 'block'; }
  if (c0 === 60 && htmlBlockType(s)) return 'block';
  if (isThematicBreak(s)) return 'block';
  if (c0 === 62) {
    // nested blockquote: paragraph inside if its content is para text
    let p = 1;
    if (p < s.length && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9)) p++;
    const inner = s.slice(p);
    if (inner.length === 0) return 'block';
    return innerLineKind(inner, openPara) === 'para' ? 'para-block' : 'block';
  }
  const m = listMarker(s);
  if (m) {
    // list item: open paragraph if it has content on the marker line
    const after = s.slice(m.markerLen).replace(/^[ \t]+/, '');
    return after.length > 0 ? 'para-block' : 'block';
  }
  // setext underline / table delimiter: only meaningful right after a para
  if (openPara) {
    if (/^=+[ \t]*$/.test(s) || /^-+[ \t]*$/.test(s)) return 'block'; // setext
  }
  return 'para';
}

// Collect the inner lines of a blockquote starting at lines[i].
// Returns {inner: [{s,f}], next} where next is the index past the blockquote.
function collectBlockquote(lines, i, end) {
  const inner = [];
  let j = i;
  let openPara = false;
  let inFence = null; // {ch, len}
  while (j < end) {
    const L = lines[j];
    if (isBlankLine(L.s)) break; // a truly blank line ends the blockquote
    const [ind, ci] = indentOf(L.s);
    const s = L.s.slice(ci);
    if (ind <= 3 && s.charCodeAt(0) === 62) {
      // '>' line
      const content = stripBlockquotePrefix(s, ind);
      if (inFence) {
        inner.push({ s: content, f: 0 });
        if (isFenceClose(content.replace(/^[ \t]+/, ''), inFence.ch, inFence.len)) inFence = null;
        j++;
        continue;
      }
      const [cind] = indentOf(content);
      const fi = cind < 4 ? fenceInfo(content.replace(/^[ \t]+/, '')) : null;
      if (fi) inFence = fi;
      const kind = cind >= 4 ? 'block' : innerLineKind(content.replace(/^[ \t]+/, ''), openPara);
      // table delimiter row: if openPara and it parses as a delimiter, the
      // paragraph becomes a table (no open paragraph after).
      if (openPara && kind === 'para') {
        const cells = splitTableRow(content.replace(/^[ \t]+/, ''));
        if (cells && parseDelimRow(content.replace(/^[ \t]+/, ''))) {
          inner.push({ s: content, f: 0 });
          openPara = false;
          j++;
          continue;
        }
      }
      inner.push({ s: content, f: 0 });
      openPara = (kind === 'para' || kind === 'para-block');
      j++;
      continue;
    }
    // Non-'>' line: lazy continuation only if a paragraph is open and the
    // line is paragraph continuation text (not a setext underline, hr, or
    // block start). A lazy line also propagates into a nested container
    // (blockquote/list) whose own collection decides whether to claim it.
    if (inFence) break; // code content cannot be lazy
    if (!openPara) {
      // Is the last inner line a nested container that might hold an open
      // paragraph at a deeper level?
      let nested = false;
      for (let b = inner.length - 1; b >= 0; b--) {
        const bs = inner[b].s;
        if (isBlankLine(bs)) continue;
        const [bind] = indentOf(bs);
        const bcontent = bs.slice(bind);
        if (bcontent.charCodeAt(0) === 62 || listMarker(bcontent)) nested = true;
        break;
      }
      if (!nested) break;
    }
    const ls = ind <= 3 ? s : L.s;
    if (isThematicBreak(ls)) break;
    if (isAtxHeading(ls) || fenceInfo(ls) || (ls.charCodeAt(0) === 60 && htmlBlockType(ls)) || listMarker(ls)) break;
    // A lazy setext underline (= run, or - run too short to be a thematic
    // break) is paragraph text, rendered with 4 spaces prepended.
    if (/^[ \t]*(=+|-+)[ \t]*$/.test(ls)) {
      inner.push({ s: '    ' + ls.replace(/^[ \t]+/, ''), f: 0 });
      j++;
      continue;
    }
    inner.push({ s: L.s, f: 1 });
    j++;
  }
  return { inner, next: j };
}

function blockTokens(lines, start, end, refs, isTop = true, inList = false) {
  const tokens = [];
  let loose = false; // a blank line separated two top-level blocks
  let blankSeen = false;
  let i = start;
  while (i < end) {
    const L = lines[i];
    if (isBlankLine(L.s)) { blankSeen = true; i++; continue; }
    if (blankSeen && tokens.length > 0) loose = true;
    blankSeen = false;
    const [indent, ci] = indentOf(L.s);
    if (indent >= 4) {
      // indented code block
      const parts = [];
      let j = i;
      while (j < end) {
        const lj = lines[j].s;
        if (isBlankLine(lj)) {
          let k = j;
          const blanks = [];
          while (k < end && isBlankLine(lines[k].s)) { blanks.push(stripIndent(lines[k].s, 4)); k++; }
          if (k < end) {
            const [ind2] = indentOf(lines[k].s);
            if (ind2 >= 4) { for (const b of blanks) parts.push(b); j = k; continue; }
          }
          break;
        }
        const [ind2] = indentOf(lj);
        if (ind2 < 4) break;
        parts.push(stripIndent(lj, 4));
        j++;
      }
      while (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
      tokens.push({ t: 'icode', content: parts.length ? parts.join('\n') + '\n' : '' });
      i = j;
      continue;
    }
    const s = L.s.slice(ci);
    // ATX heading
    const atx = isAtxHeading(s);
    if (atx) {
      let content = s.slice(atx);
      content = content.replace(/[ \t]+#+[ \t]*$/, '');
      content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      tokens.push({ t: 'h', level: atx, text: content });
      i++;
      continue;
    }
    // fenced code
    const fence = fenceInfo(s);
    if (fence) {
      const m = fence.info.match(/[^ \t]+/);
      const lang = m ? unescapeBackslash(m[0]) : '';
      const parts = [];
      let j = i + 1;
      while (j < end) {
        const lj = lines[j].s;
        const [ind2, cj] = indentOf(lj);
        if (ind2 <= 3) {
          const ls = lj.slice(cj);
          if (isFenceClose(ls, fence.ch, fence.len)) break;
        }
        parts.push(lj);
        j++;
      }
      // Dt (indentCodeCompensation, marked's fences tokenizer): the
      // compensation is the OPENER line's leading whitespace (chars),
      // and only for a ``` opener (a ~~~ opener matches nothing, so
      // its content keeps its full indent). For each content line,
      // slice min(leadingWhitespaceLength, compensation) chars.
      // No leading whitespace on the opener, or a ~~~ opener => no
      // compensation at all. Applies whether or not a closer was found
      // (an unclosed fence still gets the compensation — doc-13/23
      // orphan fences).
      const cm = L.s.match(/^(\s+)(?:```)/);
      if (cm) {
        const comp = cm[1].length;
        for (let p = 0; p < parts.length; p++) {
          const bm = parts[p].match(/^\s+/);
          if (bm) parts[p] = parts[p].slice(Math.min(bm[0].length, comp));
        }
      }
      if (j < end) j++; // consume closing fence
      // content = lines joined with \n; add a trailing \n only when the
      // join does not already end with one (blank lines before the
      // closing fence supply it).
      let content = parts.join('\n');
      if (content.length && !content.endsWith('\n')) content += '\n';
      tokens.push({ t: 'code', lang, content });
      i = j;
      continue;
    }
    // HTML block (types 1-6 can interrupt a paragraph; type 7 cannot, but
    // we are at a block boundary here so it is fine)
    const htype = htmlBlockType(s);
    if (htype) {
      const parts = [];
      let j = i;
      let endAtBlank = false;
      if (htype === 1) {
        const nm = s.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/);
        const tag = nm ? nm[1].toLowerCase() : '';
        const closeRe = new RegExp('</' + tag + '[\\s>]', 'i');
        while (j < end) {
          parts.push(lines[j].s);
          if (closeRe.test(lines[j].s)) { j++; break; }
          j++;
        }
      } else if (htype === 2) {
        while (j < end) {
          parts.push(lines[j].s);
          if (lines[j].s.indexOf('-->') >= 0) { j++; break; }
          j++;
        }
      } else if (htype === 3) {
        while (j < end) {
          parts.push(lines[j].s);
          if (lines[j].s.indexOf('?>') >= 0) { j++; break; }
          j++;
        }
      } else if (htype === 4) {
        while (j < end) {
          parts.push(lines[j].s);
          if (lines[j].s.indexOf('>', 2) >= 0) { j++; break; }
          j++;
        }
      } else if (htype === 5) {
        while (j < end) {
          parts.push(lines[j].s);
          if (lines[j].s.indexOf(']]>') >= 0) { j++; break; }
          j++;
        }
      } else {
        // types 6-7: until a blank line or EOF
        while (j < end && !isBlankLine(lines[j].s)) { parts.push(lines[j].s); j++; }
        endAtBlank = j < end;
      }
      // trailing newline: appended unless the block ends at a blank line.
      // At the end of a nested container (blockquote/list) there is no
      // trailing newline; at top-level EOF it follows the input's final \n.
      // For types 1-5 the block ends at its terminator line: the newline
      // after it is included UNLESS the next line is truly empty (zero
      // characters). A whitespace-only next line (spaces/tabs) still gets
      // the newline (marked quirk: <!-- --> + \n\t\npara keeps the \n,
      // <!-- --> + \n\npara does not).
      let addNL = false;
      if (htype >= 6) {
        if (!endAtBlank) addNL = isTop ? HTML_ENDS_NL : false;
      } else {
        if (j >= end) addNL = isTop ? HTML_ENDS_NL : false;
        else if (lines[j].s.length > 0) addNL = true;
      }
      tokens.push({ t: 'html', lines: parts, nl: addNL });
      i = j;
      continue;
    }
    // thematic break
    if (isThematicBreak(s)) { tokens.push({ t: 'hr' }); i++; continue; }
    // blockquote
    if (s.charCodeAt(0) === 62) {
      const { inner, next } = collectBlockquote(lines, i, end);
      const { tokens: children } = blockTokens(inner, 0, inner.length, refs, false);
      tokens.push({ t: 'bq', blocks: children });
      i = next;
      continue;
    }
    // list
    const lm = listMarker(s);
    if (lm) {
      const res = parseList(lines, i, end, refs);
      tokens.push(res.token);
      i = res.next;
      continue;
    }
    // paragraph (with link ref defs, setext heading, table)
    const pr = parseParagraph(lines, i, end, refs, inList);
    if (pr.token) tokens.push(pr.token);
    i = pr.next;
  }
  return { tokens, loose };
}

// ------------------------------------------------------- list + paragraph
function sameMarker(m, bullet, delim) {
  if (bullet) return m.bullet && m.marker === delim;
  return !m.bullet && m.marker.slice(-1) === delim;
}

// Content of a list marker line: the text after the marker and the spaces
// up to the content column (contentCol, absolute). Leading tabs after the
// marker are expanded to spaces on the ORIGINAL columns, so a tab after
// the cut keeps its correct width.
function markerLineContent(line, ci, ind, m, contentCol) {
  let col = ind + m.markerLen; // column just after the marker
  let i = ci + m.markerLen;
  let spaces = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { spaces += ' '; col++; i++; }
    else if (c === 9) { const w = 4 - (col & 3); spaces += ' '.repeat(w); col += w; i++; }
    else break;
  }
  const drop = contentCol - (ind + m.markerLen);
  if (drop <= 0) return spaces + line.slice(i);
  if (drop >= spaces.length) return line.slice(i);
  return spaces.slice(drop) + line.slice(i);
}

// Content of a blockquote '>' line: s starts with '>' at absolute column
// ind. Remove '>' and one following space (a tab counts as a space but
// only 1 column is consumed); leading tabs are expanded to spaces on the
// ORIGINAL columns.
function stripBlockquotePrefix(s, ind) {
  let col = ind + 1; // column after '>'
  let i = 1;
  if (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col & 3);
      let spaces = ' '.repeat(w - 1);
      col += w;
      i++;
      while (i < s.length) {
        const c2 = s.charCodeAt(i);
        if (c2 === 32) { spaces += ' '; col++; i++; }
        else if (c2 === 9) { const w2 = 4 - (col & 3); spaces += ' '.repeat(w2); col += w2; i++; }
        else break;
      }
      return spaces + s.slice(i);
    }
  }
  let spaces = '';
  while (i < s.length) {
    const c2 = s.charCodeAt(i);
    if (c2 === 32) { spaces += ' '; col++; i++; }
    else if (c2 === 9) { const w2 = 4 - (col & 3); spaces += ' '.repeat(w2); col += w2; i++; }
    else break;
  }
  return spaces + s.slice(i);
}

// Text of a paragraph line, applying the container "strip 4" rule when the
// line's flag is set and its indent is >= 4.
function paraLineText(L) {
  if (!L.f) return L.s;
  const [ind] = indentOf(L.s);
  if (ind >= 4) return stripIndent(L.s, 4);
  return L.s;
}

function parseList(lines, i, end, refs) {
  const first = lines[i];
  const [indent0, ci0] = indentOf(first.s);
  const m0 = listMarker(first.s.slice(ci0));
  const bullet = m0.bullet;
  const delim = bullet ? m0.marker : m0.marker.slice(-1);
  const startNum = bullet ? 0 : m0.start;
  const items = [];
  let loose = false;
  let j = i;
  while (j < end) {
    if (isBlankLine(lines[j].s)) {
      let k = j + 1;
      while (k < end && isBlankLine(lines[k].s)) k++;
      if (k < end) {
        const [indk, cik] = indentOf(lines[k].s);
        const mk = indk <= 3 ? listMarker(lines[k].s.slice(cik)) : null;
        if (mk && sameMarker(mk, bullet, delim)) { loose = true; j = k; continue; }
      }
      break;
    }
    const [ind, ci] = indentOf(lines[j].s);
    if (ind > 3) break;
    const ls0 = lines[j].s.slice(ci);
    if (isThematicBreak(ls0)) break; // a thematic break ends the list
    const m = listMarker(ls0);
    if (!m || !sameMarker(m, bullet, delim)) break;
    const contentCol = itemContentIndent(lines[j].s, ci, ind, m);
    const inner = [];
    let task = false, checked = false;
    let itemHasContent = false;
    let openPara = false;
    let inFence = null;
    // True while the most recently collected line is the fence opener
    // itself: a low-indent line after it ENDS the item (marked's
    // ee.test(m) break). Once a content line is collected, low-indent
    // lines are lazy continuations of the item text and become fence
    // content when the item is re-lexed.
    let fenceOpenerPending = false;
    // first line content
    let firstContent = markerLineContent(lines[j].s, ci, ind, m, contentCol);
    // task checkbox at the start of the item content
    if (firstContent.length >= 3 && firstContent.charCodeAt(0) === 91) {
      const c1 = firstContent.charCodeAt(1);
      if ((firstContent.charCodeAt(2) === 93) && (c1 === 32 || c1 === 120 || c1 === 88)) {
        const after = firstContent.charCodeAt(3);
        if (firstContent.length === 3 || after === 32 || after === 9) {
          task = true;
          checked = (c1 === 120 || c1 === 88);
          firstContent = firstContent.length > 3 ? firstContent.slice(4) : '';
        }
      }
    }
    inner.push({ s: firstContent, f: 1 });
    if (firstContent.trim() !== '') {
      itemHasContent = true;
      const fc = firstContent.replace(/^[ \t]+/, '');
      if (!inFence) {
        const fi = fenceInfo(fc);
        if (fi) { inFence = fi; fenceOpenerPending = true; }
        else openPara = innerLineKind(fc, false) !== 'block';
      }
    }
    j++;
    // following lines of this item
    while (j < end) {
      const L = lines[j];
      if (isBlankLine(L.s)) {
        // An item with no content yet cannot contain a blank line: the
        // list ends and the following indented line is a separate block.
        if (!itemHasContent) break;
        let k = j, blanks = 0;
        while (k < end && isBlankLine(lines[k].s)) { k++; blanks++; }
        if (k < end) {
          const [indk, cik] = indentOf(lines[k].s);
          if (indk < contentCol && indk <= 3) {
            const mk = listMarker(lines[k].s.slice(cik));
            if (mk && sameMarker(mk, bullet, delim)) {
              loose = true;
              for (let b = 0; b < blanks; b++) inner.push({ s: '', f: 0 });
              j = k;
              break;
            }
          }
          const [indk2] = indentOf(lines[k].s);
          if (indk2 >= contentCol) {
            for (let b = 0; b < blanks; b++) inner.push({ s: '', f: 0 });
            j = k;
            openPara = false;
            continue;
          }
        }
        break;
      }
      const [ind2, ci2] = indentOf(L.s);
      if (ind2 < contentCol && ind2 <= 3) {
        const ls2 = L.s.slice(ci2);
        if (isThematicBreak(ls2)) break; // a thematic break ends the list
        const m2 = listMarker(ls2);
        if (m2 && sameMarker(m2, bullet, delim)) break;
      }
      if (ind2 >= contentCol) {
        const content = stripColumns(L.s, contentCol);
        if (inFence) {
          inner.push({ s: content, f: 1 });
          // A collected content line means the previous line is no
          // longer the fence opener.
          fenceOpenerPending = false;
          if (isFenceClose(content.replace(/^[ \t]+/, ''), inFence.ch, inFence.len)) inFence = null;
        } else {
          const cc = content.replace(/^[ \t]+/, '');
          const fi = fenceInfo(cc);
          if (fi) { inFence = fi; fenceOpenerPending = true; }
          const kind = innerLineKind(cc, openPara);
          if (openPara && kind === 'para') {
            if (parseDelimRow(cc)) { inner.push({ s: content, f: 1 }); openPara = false; }
            else { inner.push({ s: content, f: 1 }); openPara = true; }
          } else {
            inner.push({ s: content, f: 1 });
            openPara = (kind === 'para' || kind === 'para-block');
          }
        }
        if (content.trim() !== '') itemHasContent = true;
        j++;
        continue;
      }
      // lazy line (indent < contentCol)
      // A block-start line at indent <= min(3, contentCol-1) ends the
      // item (marked's first break check: the fence/heading/HTML/
      // bullet/HR regexes are capped at R-1). A fence line can never
      // close a fence opened inside the item — it is a new fence at
      // top level. This check must run BEFORE the inFence absorption.
      const capInd = contentCol - 1 < 3 ? contentCol - 1 : 3;
      const ls0 = L.s.slice(ci2);
      if (ind2 <= capInd && (isThematicBreak(ls0) || isAtxHeading(ls0) || fenceInfo(ls0) ||
          (ls0.charCodeAt(0) === 60 && htmlBlockType(ls0)) || listMarker(ls0) ||
          ls0.charCodeAt(0) === 62)) break;
      if (inFence) {
        // The line right after a fence opener ends the item (marked:
        // ee.test(m) — the previous outdented line is a fence begin),
        // so the fence becomes an EMPTY code block inside the item.
        // Only after a content line has been collected can low-indent
        // lines continue the fence (lazy lines of the item text).
        if (fenceOpenerPending) break;
        const content = stripColumns(L.s, contentCol);
        inner.push({ s: content, f: 1 });
        fenceOpenerPending = false;
        if (isFenceClose(content.replace(/^[ \t]+/, ''), inFence.ch, inFence.len)) inFence = null;
        if (content.trim() !== '') itemHasContent = true;
        j++;
        continue;
      }
      if (!openPara) break;
      const ls = L.s.slice(ci2);
      if (isThematicBreak(ls) || isAtxHeading(ls) || fenceInfo(ls) ||
          (ls.charCodeAt(0) === 60 && htmlBlockType(ls)) || (ci2 <= 3 && listMarker(ls))) break;
      // A lazy setext underline (= run, or - run too short to be a thematic
      // break) is paragraph text, rendered with 4 spaces prepended.
      if (/^[ \t]*(=+|-+)[ \t]*$/.test(ls)) {
        inner.push({ s: '    ' + ls.replace(/^[ \t]+/, ''), f: 0 });
        j++;
        continue;
      }
      inner.push({ s: L.s, f: 1 });
      j++;
    }
    const { tokens: blocks, loose: itemLoose } = blockTokens(inner, 0, inner.length, refs, false, true);
    if (itemLoose) loose = true;
    items.push({ task, checked, blocks });
  }
  const token = { t: bullet ? 'ul' : 'ol', start: startNum, items, loose };
  return { token, next: j };
}

function parseParagraph(lines, i, end, refs, inList = false) {
  let j = i;
  // link reference definitions at the start of the paragraph
  while (j < end) {
    if (isBlankLine(lines[j].s)) break;
    const def = parseLinkRefDef(lines, j, end);
    if (!def) break;
    if (!refs.has(def.label)) refs.set(def.label, { dest: def.dest, title: def.title });
    j = def.next;
  }
  if (j >= end || isBlankLine(lines[j].s)) return { token: null, next: j };
  // table? header line + delimiter row
  if (j + 1 < end && !isBlankLine(lines[j + 1].s)) {
    const [, ciH] = indentOf(lines[j].s);
    const [, ciD] = indentOf(lines[j + 1].s);
    const headLine = lines[j].s.slice(ciH);
    const delimLine = lines[j + 1].s.slice(ciD);
    const headCells = splitTableRow(headLine);
    const align = parseDelimRow(delimLine);
    if (headCells && align && headCells.length === align.length) {
      const rows = [];
      let k = j + 2;
      // A whitespace-only line that is exactly one tab (after stripping
      // up to 3 leading spaces) is a table row of empty cells; any other
      // blank line ends the table. (Marked quirk: "\t" and " \t" are
      // rows, but "\t ", "\t\t" and spaces-only are not.)
      const isTabRow = (s) => {
        let i = 0;
        while (i < s.length && i < 3 && s.charCodeAt(i) === 32) i++;
        return i < s.length && s.charCodeAt(i) === 9 && i + 1 === s.length;
      };
      while (k < end && (!isBlankLine(lines[k].s) || isTabRow(lines[k].s))) {
        const [, cik] = indentOf(lines[k].s);
        const rowLine = lines[k].s.slice(cik);
        // a line starting a new block (blockquote, heading, fence, hr,
        // list, HTML block types 1-6) ends the table; a plain line is
        // a (single-cell) row
        if (rowLine.charCodeAt(0) === 62 || isAtxHeading(rowLine) || fenceInfo(rowLine) || isThematicBreak(rowLine) || listMarker(rowLine)) break;
        const hb = htmlBlockType(rowLine);
        if (hb >= 1 && hb <= 6) break;
        // a body row without a pipe is a single-cell row (padded below)
        let cells = splitTableRow(rowLine);
        if (!cells) cells = [rowLine.trim()];
        while (cells.length < headCells.length) cells.push('');
        if (cells.length > headCells.length) cells = cells.slice(0, headCells.length);
        rows.push(cells);
        k++;
      }
      return { token: { t: 'table', align, head: headCells, rows }, next: k };
    }
  }
  // collect paragraph lines
  const paraLines = [];
  let k = j;
  let setextLevel = 0;
  while (k < end) {
    const L = lines[k];
    if (isBlankLine(L.s)) {
      // A whitespace-only line that is the LAST line of the container is
      // a paragraph line (its spaces are kept); otherwise it ends the para.
      if (k === end - 1 && L.s.length > 0) { paraLines.push(L); k++; continue; }
      break;
    }
    const [ind, ci] = indentOf(L.s);
    const s = L.s.slice(ci);
    if (paraLines.length > 0 && ind <= 3) {
      if (/^=+[ \t]*$/.test(s)) { setextLevel = 1; k++; break; }
      if (/^-+[ \t]*$/.test(s)) { setextLevel = 2; k++; break; }
    }
    if (ind < 4) {
      if (isAtxHeading(s)) break;
      if (fenceInfo(s)) break;
      const ht = htmlBlockType(s);
      if (ht >= 1 && ht <= 6) break;
      if (isThematicBreak(s)) break;
      if (s.charCodeAt(0) === 62) break;
      const lm = listMarker(s);
      // A list interrupts a paragraph, except an EMPTY list item (marker
      // with no content) and, at top level, an ordered list starting at
      // a number != 1. Inside a list item a nested ordered list of any
      // start number interrupts the item's paragraph.
      if (lm) {
        const after = s.slice(ci + lm.markerLen).replace(/^[ \t]+/, '');
        if (after.length > 0 && (lm.bullet || lm.start === 1 || inList)) break;
      }
    }
    paraLines.push(L);
    k++;
  }
  if (paraLines.length === 0) return { token: null, next: k };
  const text = paraLines.map(paraLineText).join('\n');
  if (setextLevel) {
    const t = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    return { token: { t: 'h', level: setextLevel, text: t }, next: k };
  }
  return { token: { t: 'p', text }, next: k };
}

// ---------------------------------------------------------------- renderer
function renderBlocks(tokens, refs, out, tight) {
  for (const tok of tokens) {
    switch (tok.t) {
      case 'p': {
        if (tight) out.push(inline(tok.text, refs));
        else out.push('<p>' + inline(tok.text, refs) + '</p>\n');
        break;
      }
      case 'h': {
        out.push('<h' + tok.level + '>' + inline(tok.text, refs) + '</h' + tok.level + '>\n');
        break;
      }
      case 'code': {
        out.push('<pre><code' + (tok.lang ? ' class="language-' + escapeAttr(tok.lang) + '"' : '') + '>' + escapeHtml(tok.content) + '</code></pre>\n');
        break;
      }
      case 'icode': {
        out.push('<pre><code>' + escapeHtml(tok.content) + '</code></pre>\n');
        break;
      }
      case 'html': {
        out.push(tok.lines.join('\n'));
        if (tok.nl) out.push('\n');
        break;
      }
      case 'hr': {
        out.push('<hr>\n');
        break;
      }
      case 'bq': {
        out.push('<blockquote>\n');
        renderBlocks(tok.blocks, refs, out, false);
        out.push('</blockquote>\n');
        break;
      }
      case 'ul':
      case 'ol': {
        out.push(tok.t === 'ul' ? '<ul>\n' : (tok.start !== 1 ? '<ol start="' + tok.start + '">\n' : '<ol>\n'));
        for (const item of tok.items) {
          out.push('<li>');
          const itemTight = !tok.loose;
          const itemOut = [];
          let first = true;
          for (const bt of item.blocks) {
            if (first && item.task) {
              const inp = item.checked
                ? '<input checked="" disabled="" type="checkbox"> '
                : '<input disabled="" type="checkbox"> ';
              if (bt.t === 'p') {
                if (itemTight) itemOut.push(inp + inline(bt.text, refs));
                else itemOut.push('<p>' + inp + inline(bt.text, refs) + '</p>\n');
              } else {
                itemOut.push(inp);
                renderBlocks([bt], refs, itemOut, false);
              }
              first = false;
            } else {
              renderBlocks([bt], refs, itemOut, itemTight);
              first = false;
            }
          }
          out.push(itemOut.join(''));
          out.push('</li>\n');
        }
        out.push(tok.t === 'ul' ? '</ul>\n' : '</ol>\n');
        break;
      }
      case 'table': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (let a = 0; a < tok.head.length; a++) {
          const al = tok.align[a];
          out.push('<th' + (al ? ' align="' + al + '"' : '') + '>' + inline(tok.head[a], refs) + '</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        if (tok.rows.length > 0) {
          out.push('<tbody>');
          for (const row of tok.rows) {
            out.push('<tr>\n');
            for (let a = 0; a < row.length; a++) {
              const al = tok.align[a];
              out.push('<td' + (al ? ' align="' + al + '"' : '') + '>' + inline(row[a], refs) + '</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody>');
        }
        out.push('</table>\n');
        break;
      }
    }
  }
}

// Escape inline text: & < > " ' are escaped, but a valid entity passes
// through (named as-is, numeric decoded).
function escapeText(s) {
  let r = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const e = entityEnd(s, i);
      if (e > 0) {
        if (s.charCodeAt(i + 1) === 35) {
          const dec = decodeNumericEntity(s, i);
          if (dec) {
            const ch = dec[1];
            if (ch === '"') r += '&quot;';
            else if (ch === "'") r += '&#39;';
            else if (ch === '<') r += '&lt;';
            else if (ch === '>') r += '&gt;';
            else if (ch === '&') r += '&amp;';
            else r += ch;
            i = dec[0];
          } else { r += s.slice(i, e); i = e; }
        } else {
          r += s.slice(i, e);
          i = e;
        }
      } else { r += '&amp;'; i++; }
    } else if (c === 60) { r += '&lt;'; i++; }
    else if (c === 62) { r += '&gt;'; i++; }
    else if (c === 34) { r += '&quot;'; i++; }
    else if (c === 39) { r += '&#39;'; i++; }
    else { r += s[i]; i++; }
  }
  return r;
}

// ---------------------------------------------------------------- inline
// Flanking classification for a delimiter run at [i, i+len) in s.
function flankInfo(s, i, len) {
  const before = i > 0 ? s.charCodeAt(i - 1) : -1;
  const after = i + len < s.length ? s.charCodeAt(i + len) : -1;
  const beforeIsSpace = before < 0 || isSpaceCode(before);
  const afterIsSpace = after < 0 || isSpaceCode(after);
  const beforeIsPunct = before >= 0 && isPunctCode(before);
  const afterIsPunct = after >= 0 && isPunctCode(after);
  const leftFlanking = !afterIsSpace && (!afterIsPunct || beforeIsSpace || beforeIsPunct);
  const rightFlanking = !beforeIsSpace && (!beforeIsPunct || afterIsSpace || afterIsPunct);
  return { leftFlanking, rightFlanking };
}

function inline(text, refs, inLink) {
  const out = [];
  const delims = []; // {ch, len, canOpen, canClose, idx, pos}
  let i = 0;
  const n = text.length;
  let lastLinkOpenPos = -1;
  let litStart = 0;
  // Emphasis pairs whose opener is preceded by whitespace and whose
  // closer is immediately followed by a non-whitespace character
  // ("attached" pair). Such a pair blocks an outer same-character pair
  // whose use differs from its own (marked quirk: *foo **bar**baz*
  // keeps the outer * literal, but *foo**bar**baz* and *(**foo**)*
  // form <em> because their inner opener is not preceded by space).
  // Entries: {ch, openerPos, closerEnd, use}.
  const blockedPairs = [];
  // History of every */_/~ delimiter run pushed in this inline call
  // (original position/length, append-only). Marked's emStrong scans
  // the raw text, so runs already consumed by inner pairs still count
  // when an outer pair is resolved — the b_eff accounting below reads
  // this log, not the live delimiter stack.
  const runLog = [];
  // Pending backtick-run lengths left over from a link/image whose text
  // contains unpaired backticks (marked #n masking: an emphasis closer
  // after such a link is suppressed when the next backtick run has one
  // of the leftover lengths). Set by the first link/image with
  // leftovers (first-wins); cleared (consumed) by the first
  // suppression, after which a later link may set it again.
  let pendingTickLens = new Set();
  let tickRuns = null;
  function nextTickRun(pos) {
    if (!tickRuns) {
      tickRuns = [];
      let p = 0;
      while (p < n) {
        if (text.charCodeAt(p) === 96) {
          let q = p;
          while (q < n && text.charCodeAt(q) === 96) q++;
          tickRuns.push({ pos: p, len: q - p });
          p = q;
        } else p++;
      }
    }
    for (let k = 0; k < tickRuns.length; k++) if (tickRuns[k].pos >= pos) return tickRuns[k];
    return null;
  }
  function suppressedByTicks(closer) {
    if (pendingTickLens.size === 0) return false;
    const run = nextTickRun(closer.pos + closer.origLen);
    if (run && pendingTickLens.has(run.len)) { pendingTickLens.clear(); return true; }
    return false;
  }
  function flush(upto) {
    if (upto > litStart) { out.push(escapeText(text.slice(litStart, upto))); litStart = upto; }
  }
  function pushDelim(ch, len, canOpen, canClose, pos) {
    flush(pos);
    out.push(ch.repeat(len));
    delims.push({ ch, len, origLen: len, canOpen, canClose, idx: out.length - 1, pos });
    if (ch === '*' || ch === '_' || ch === '~') runLog.push({ ch, pos, len });
  }
  // Classify a delimiter run by its neighbours for the emStrong
  // accounting (marked RDelim groups): 1 = opener-like (groups 3/4),
  // 2 = closer-like (groups 1/2), 3 = both-flanking (groups 5/6),
  // 0 = neither. before/after are char codes, or -1 for end of text
  // (counts as whitespace). '~' counts as "other" for * runs (the
  // RDelim regex adds |~ to the other-class) but as punctuation for
  // _ runs.
  function runKind(ch, before, after) {
    const cat = (c) => {
      if (c < 0) return 0; // ws (end of text)
      if (isSpaceCode(c)) return 0;
      if (ch === 42 && c === 126) return 2; // '~' is "other" for *
      return isPunctCode(c) ? 1 : 2;
    };
    const b = cat(before), a = cat(after);
    if (b === 0 && a === 0) return 0;
    if (b === 0) return 1; // ws before: opener (groups 3/4)
    if (b === 1 && a === 0) return 2; // punct before, ws after: closer (1)
    if (b === 1 && a === 1) return 3; // punct/punct: both (5)
    if (b === 1) return 1; // punct before, other after: opener (3)
    if (b === 2 && a === 2) return 3; // other/other: both (6)
    return 2; // other before, ws/punct after: closer (2)
  }
  // emStrong-faithful closer accounting for an (opener, closer) pair
  // (marked's m/f/b_eff): m starts at the opener length; opener-like
  // runs between add to it, closer-like runs subtract; both-flanking
  // runs skipped by the Rule of 3 (y%3 && (y+len)%3==0, y = opener
  // length) add to f instead. b_eff = min(closerLen, closerLen + m' +
  // f) where m' = m - closerLen. Of the closer run's leftover chars,
  // `inside` (= b_eff - use, floored at 0) stay INSIDE the emphasis
  // (before the closing tag) and `after` stay after it. Returns null
  // when the closer is adjacent to the opener (no match possible in
  // marked's scan) — the caller then falls back to the old layout.
  // NOTE: this only decides the PLACEMENT of the leftover chars, not
  // whether the pair matches (the m'>0 rule is deliberately NOT
  // applied: this stack resolves inner pairs first and matches the
  // same pairs in a different order, e.g. **a b* c* d**).
  function emphAccount(opener, closer) {
    const oEnd = opener.pos + opener.origLen;
    if (closer.pos <= oEnd) return null;
    const y = opener.len;
    let m = opener.len, f = 0;
    for (let k = 0; k < runLog.length; k++) {
      const r = runLog[k];
      if (r.ch !== opener.ch) continue;
      if (r.pos < oEnd || r.pos >= closer.pos) continue;
      const kind = runKind(opener.ch,
        text.charCodeAt(r.pos - 1),
        r.pos + r.len < n ? text.charCodeAt(r.pos + r.len) : -1);
      if (kind === 1) m += r.len;
      else if (kind === 2) m -= r.len;
      else if (kind === 3) {
        if (y % 3 !== 0 && (y + r.len) % 3 === 0) f += r.len;
        else m -= r.len;
      }
    }
    const mPrime = m - closer.len;
    const bEff = Math.min(closer.len, closer.len + mPrime + f);
    const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    const inside = Math.max(0, bEff - use);
    const after = closer.len - use - inside;
    return { inside, after };
  }
  // Resolve emphasis/strong for a closer at delims[ci].
  function resolveEmph(ci) {
    const closer = delims[ci];
    if (!closer.canClose || closer.dead) return;
    if (suppressedByTicks(closer)) return;
    // A closer may match several openers in turn (e.g. ** closing two
    // nested ems). Loop while it still has length.
    while (closer.len > 0) {
      let matched = false;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const opener = delims[oi];
        if (opener.ch !== closer.ch || !opener.canOpen) continue;
        // rule of 3
        if ((opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose)) {
          const sum = opener.len + closer.len;
          if (sum % 3 === 0 && (opener.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
        }
        // An attached pair strictly between this opener and closer
        // blocks the pair when the opener is longer than the closer
        // (a partial match would strand the opener) or when its use
        // differs from this pair's use — but only once: the blocking
        // pair is consumed by the first outer closer it stops, so a
        // later outer closer (e.g. the final **) can still match.
        // (Marked quirks: *foo **bar**baz* keeps the outer * literal;
        // **a *b*cd* e** keeps the * after cd literal yet the final **
        // forms the outer strong; __foo, __bar__, baz__ nests both
        // strongs; *changes *else*returns** forms the outer em because
        // the closer run is longer than the opener.)
        {
          const outerUse = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
          let blockedIdx = -1;
          for (let bi = 0; bi < blockedPairs.length; bi++) {
            const bp = blockedPairs[bi];
            // A blocking pair only stops a closer that is no longer than
            // the opener: a *** closer (len 3) still closes a ** opener
            // (doc-11 **return that *old*two***, doc-30 **by command
            // *tool*one***), leaving the extra * literal inside.
            if (bp.ch === closer.ch && bp.openerPos > opener.pos && bp.closerEnd <= closer.pos && closer.len <= opener.len && (opener.len > closer.len || bp.use !== outerUse)) { blockedIdx = bi; break; }
          }
          if (blockedIdx >= 0) {
            blockedPairs.splice(blockedIdx, 1);
            // A closer blocked from its nearest opener taints that opener
            // when an earlier same-char opener exists: the opener can no
            // longer match a later closer (marked quirk: in
            // **a *b **c**d* e** the * after d is blocked from *b, so *b
            // stays literal and the final ** closes the outer strong;
            // in **removes example *input **parse**parse* release** the
            // * after parse is blocked from *input, so the final **
            // closes the outer strong). When the blocked opener IS the
            // outermost one (**a *b*cd* e**) there is no earlier opener,
            // so it stays matchable and the final ** still closes it.
            // The blocked closer is dead for good: it must NOT be
            // revived later by resolveDeferredClosers (doc-26: the *
            // after "open" is blocked from *better by the **parser**
            // pair and stays literal even though links follow).
            let hasEarlier = false;
            for (let ej = oi - 1; ej >= 0; ej--) {
              if (delims[ej].ch === closer.ch && delims[ej].canOpen && delims[ej].len > 0) { hasEarlier = true; break; }
            }
            if (hasEarlier) opener.canOpen = false;
            closer.dead = true;
            break;
          }
        }
        const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        const tag = use === 2 ? 'strong' : 'em';
        // The opener/closer chunk may already hold tags from an earlier
        // match that split this run: the new opening tag goes BEFORE the
        // existing ones (it is the outer emphasis), the new closing tag
        // goes AFTER them.
        const oldOpenerLen = opener.len;
        const openerTags = out[opener.idx].slice(oldOpenerLen);
        out[opener.idx] = opener.ch.repeat(oldOpenerLen - use) + '<' + tag + '>' + openerTags;
        const oldCloserLen = closer.len;
        // b_eff placement: of the closer run's leftover chars, `inside`
        // stay INSIDE the emphasis (before the closing tag) and `after`
        // stay after it (doc-11/doc-30: **...*...*one*** keeps the *
        // inside the strong). The closer chunk holds its remaining run
        // chars as [inside][lastTag][after]; strip them via the tracked
        // layout (closeInside/closeAfter/closeLastTag) before appending
        // the new tag — a plain slice from the end is wrong once a
        // previous match left chars before the tag.
        const acct = emphAccount(opener, closer);
        const inside = acct ? acct.inside : 0;
        const after = acct ? acct.after : oldCloserLen - use;
        let closerTags;
        if (!closer.closeLastTag) {
          closerTags = '';
        } else {
          const s = out[closer.idx];
          const s1 = closer.closeAfter ? s.slice(0, s.length - closer.closeAfter) : s;
          closerTags = s1.slice(0, s1.length - closer.closeLastTag.length - closer.closeInside) + closer.closeLastTag;
        }
        out[closer.idx] = closerTags + closer.ch.repeat(inside) + '</' + tag + '>' + closer.ch.repeat(after);
        closer.closeInside = inside;
        closer.closeAfter = after;
        closer.closeLastTag = '</' + tag + '>';
        opener.len -= use;
        closer.len -= use;
        // Record an attached pair (opener preceded by a space/tab, closer
        // followed by non-whitespace) for the blocking rule above. A
        // newline before the opener does not count (cm-394: an em starting
        // a new line does not block the outer strong).
        // NOTE: use the closer's ORIGINAL run end (origLen), not the
        // remaining length: a closer run partially consumed by an inner
        // match (e.g. the last * of *** closing an em) ends after the
        // whole run, and a space after the run means NOT attached.
        {
          const after = closer.pos + closer.origLen;
          const before = opener.pos - 1;
          const preWs = before >= 0 && (text.charCodeAt(before) === 32 || text.charCodeAt(before) === 9);
          if (preWs && after < n) {
            const ac = text.charCodeAt(after);
            if (ac !== 32 && ac !== 9 && ac !== 10) blockedPairs.push({ ch: closer.ch, openerPos: opener.pos, closerEnd: after, use });
          }
        }
        // An emphasis boundary blocks openers inside it from matching a
        // closer outside it: drop any unmatched */_/~ opener strictly
        // between this opener and closer. (Do this before splicing the
        // opener out, while oi/ci are still valid indices.)
        for (let k = ci - 1; k > oi; k--) {
          const d = delims[k];
          if (d.canOpen && (d.ch === '*' || d.ch === '_' || d.ch === '~')) delims.splice(k, 1);
        }
        // A blocking pair strictly inside this formed emphasis no longer
        // blocks anything: it is nested inside a different emphasis, not
        // a direct child of the outer pair (doc-19: the *renderer* pair
        // inside _safe block ..._ does not block the outer **; doc-28/
        // doc-35: the *docs of* / *project but* pair inside __...__
        // does not block the outer **).
        for (let bi = blockedPairs.length - 1; bi >= 0; bi--) {
          const bp = blockedPairs[bi];
          if (bp.openerPos > opener.pos && bp.closerEnd <= closer.pos + closer.origLen) blockedPairs.splice(bi, 1);
        }
        if (opener.len === 0) delims.splice(delims.indexOf(opener), 1);
        matched = true;
        break;
      }
      if (!matched) break;
      // An opener before the closer may have been spliced out; re-find it.
      const newCi = delims.indexOf(closer);
      if (newCi < 0) return;
      ci = newCi;
    }
    if (closer.len === 0) {
      const idx = delims.indexOf(closer);
      if (idx >= 0) delims.splice(idx, 1);
    }
  }
  // True when an unmatched [ opener that can still form a link/image is
  // on the delimiter stack, i.e. we are inside a potential link text.
  // A link opener blocked by an already-formed inner link (pos <=
  // lastLinkOpenPos) can never form a link, so emphasis inside it must
  // NOT be deferred (otherwise, if its ] is swallowed by an autolink,
  // the emphasis would never resolve).
  function hasOpenBracket() {
    for (let k = delims.length - 1; k >= 0; k--) {
      if (delims[k].ch === '[') {
        if (delims[k].isImage) return true;
        if (delims[k].pos > lastLinkOpenPos) return true;
      }
    }
    return false;
  }
  // True when the nearest unmatched [ can still form a link/image (its
  // ] belongs to it and a following ( starts a dest). A link opener is
  // blocked once a link has formed inside it (lastLinkOpenPos).
  function nearestBracketCanForm() {
    for (let k = delims.length - 1; k >= 0; k--) {
      if (delims[k].ch === '[') {
        if (delims[k].isImage) return true;
        return delims[k].pos > lastLinkOpenPos;
      }
    }
    return false;
  }
  // Resolve every closer currently on the stack (used when a [ turns out
  // not to form a link: the deferred closers inside it become resolvable).
  function resolveDeferredClosers() {
    const closers = delims.filter(d => d.canClose && !d.dead && d.len > 0 && (d.ch === '*' || d.ch === '_' || d.ch === '~'));
    for (const cl of closers) {
      const idx = delims.indexOf(cl);
      if (idx < 0 || cl.len === 0) continue;
      if (cl.ch === '~') resolveTilde(idx);
      else resolveEmph(idx);
    }
  }
  function resolveTilde(ci) {
    const closer = delims[ci];
    if (!closer.canClose || closer.len < 1 || closer.len > 2) return;
    if (suppressedByTicks(closer)) return;
    for (let oi = ci - 1; oi >= 0; oi--) {
      const opener = delims[oi];
      if (opener.ch !== '~' || !opener.canOpen) continue;
      if (opener.len !== closer.len) continue;
      const use = opener.len;
      out[opener.idx] = '<del>';
      out[closer.idx] = '</del>';
      opener.len = 0;
      closer.len = 0;
      // delimiters opened inside this del can no longer match outside it
      delims.splice(oi + 1, ci - oi - 1);
      delims.splice(oi, 1);
      delims.splice(delims.indexOf(closer), 1);
      return;
    }
  }
  while (i < n) {
    const c = text.charCodeAt(i);
    // backslash
    if (c === 92) {
      if (i + 1 < n) {
        const nc = text.charCodeAt(i + 1);
        if (nc === 10) {
          flush(i);
          out.push('<br>');
          let j = i + 2;
          while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
          i = j;
          litStart = i;
          continue;
        }
        if (isAsciiPunct(nc)) {
          flush(i);
          out.push(escapeText(String.fromCharCode(nc)));
          i += 2; litStart = i; continue;
        }
      }
      i++;
      continue;
    }
    // code span
    if (c === 96) {
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const ticks = j - i;
      // find a matching run of the same length; a code span must not
      // swallow a link's ] : when the search meets a ] followed by (
      // or [ (a link boundary), look for a matching backtick run from
      // the ] through the end of the (...) / [...] that follows it
      // (plus the char right after it). If one is there, the ] is
      // code-span content ([a `b](c)` d](url), [not a `link](/foo`) —
      // the closer is inside or just after the parens); otherwise the
      // ] closes the link and the search stops ([docs each ``url`](...)
      // has its `` closer past the link's ]).
      let k = j;
      let close = -1, closeLen = 0;
      while (k < n) {
        if (text.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && text.charCodeAt(m) === 96) m++;
          if (m - k === ticks) { close = k; closeLen = ticks; break; }
          k = m;
        } else if (text.charCodeAt(k) === 93 && k + 1 < n && (text.charCodeAt(k + 1) === 40 || text.charCodeAt(k + 1) === 91) && hasOpenBracket()) {
          // end of the (...) or [...] after the ]
          let p = k + 1;
          if (text.charCodeAt(p) === 40) {
            let depth = 0;
            while (p < n) {
              if (text.charCodeAt(p) === 40) depth++;
              else if (text.charCodeAt(p) === 41) { depth--; if (depth === 0) { p++; break; } }
              p++;
            }
          } else {
            p++;
            while (p < n && text.charCodeAt(p) !== 93) p++;
            if (p < n) p++;
          }
          // look for a matching run from the ] to just past the construct
          let q = k, found = false;
          const lim = Math.min(n, p + 1);
          while (q < lim) {
            if (text.charCodeAt(q) === 96) {
              let r = q;
              while (r < n && text.charCodeAt(r) === 96) r++;
              if (r - q === ticks) { found = true; break; }
              q = r;
            } else q++;
          }
          if (!found) break;
          k++;
        } else k++;
      }
      if (close < 0) { i = j; continue; }
      let content = text.slice(j, close);
      // A code span whose content contains a backtick blocks the
      // enclosing link when its delimiter is 1 ([x `a``b`](u) does not
      // link even though the closer is right before the ]). For
      // delimiters >= 2 the label check in tryParseLink already rejects
      // the link when the runs do not pair up, so no deactivation here
      // (deactivating would also skip the masking check in the ]
      // handler — doc-16). Deactivate the nearest [ opener so the ]
      // stays literal (the code span still forms).
      if (content.indexOf('`') >= 0 && ticks === 1) {
        for (let d = delims.length - 1; d >= 0; d--) {
          if (delims[d].ch === '[') {
            delims.splice(d, 1);
            resolveDeferredClosers();
            break;
          }
        }
      }
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && !/^[ ]+$/.test(content)) {
        content = content.slice(1, -1);
      }
      flush(i);
      out.push('<code>' + escapeHtml(content) + '</code>');
      i = close + closeLen;
      litStart = i;
      continue;
    }
    // emphasis / strong delimiters
    if (c === 42 || c === 95) {
      let j = i;
      while (j < n && text.charCodeAt(j) === c) j++;
      const len = j - i;
      const ch = String.fromCharCode(c);
      const { leftFlanking, rightFlanking } = flankInfo(text, i, len);
      let canOpen, canClose;
      if (c === 42) { canOpen = leftFlanking; canClose = rightFlanking; }
      else { canOpen = leftFlanking && (!rightFlanking || isPunctCode(i > 0 ? text.charCodeAt(i - 1) : -1)); canClose = rightFlanking && (!leftFlanking || isPunctCode(i + len < n ? text.charCodeAt(i + len) : -1)); }
      pushDelim(ch, len, canOpen, canClose, i);
      if (canClose && !hasOpenBracket()) resolveEmph(delims.length - 1);
      i = j;
      litStart = i;
      continue;
    }
    // strikethrough
    if (c === 126) {
      let j = i;
      while (j < n && text.charCodeAt(j) === 126) j++;
      const len = j - i;
      if (len === 1 || len === 2) {
        const { leftFlanking, rightFlanking } = flankInfo(text, i, len);
        const canOpen = leftFlanking, canClose = rightFlanking;
        pushDelim('~', len, canOpen, canClose, i);
        if (canClose && !hasOpenBracket()) resolveTilde(delims.length - 1);
      } else {
        i = j;
        continue;
      }
      i = j;
      litStart = i;
      continue;
    }
    // inline HTML / autolink <...>
    if (c === 60) {
      const tagEnd = matchHtmlTag(text, i);
      if (tagEnd > 0) {
        flush(i);
        out.push(text.slice(i, tagEnd));
        // Track raw <a> elements: autolinks are suppressed inside them.
        if (text.charCodeAt(i + 1) === 47) {
          if (text.slice(i + 2, i + 3).toLowerCase() === 'a') {
            const ac = i + 3 < tagEnd ? text.charCodeAt(i + 3) : 62;
            if (ac === 62 || ac === 32 || ac === 9 || ac === 10) inAnchor = false;
          }
        } else if (text.slice(i + 1, i + 2).toLowerCase() === 'a') {
          const ac = i + 2 < tagEnd ? text.charCodeAt(i + 2) : 62;
          if (ac === 62 || ac === 32 || ac === 9 || ac === 10) inAnchor = true;
        }
        i = tagEnd;
        litStart = i;
        continue;
      }
      const al = matchAutolink(text, i);
      if (al) {
        flush(i);
        out.push(al.html);
        i = al.end;
        litStart = i;
        continue;
      }
      i++;
      continue;
    }
    // link / image
    if (c === 91 || (c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91)) {
      const isImage = c === 33;
      const openPos = isImage ? i + 1 : i;
      // pos is i (the ! for an image) so the ! is not flushed as literal
      // text; openPos is the [ position used for parsing.
      pushDelim('[', 1, true, false, i);
      delims[delims.length - 1].isImage = isImage;
      delims[delims.length - 1].openPos = openPos;
      i = openPos + 1;
      litStart = i;
      continue;
    }
    // closing ] — try to form a link
    if (c === 93) {
      // The ] matches the nearest [ opener (bracket nesting). If that
      // opener is a link opener inside an already-formed link, no link
      // forms here and the opener is deactivated; we do not skip to an
      // outer [ (the ] belongs to the nearest one).
      let oi = -1;
      for (let k = delims.length - 1; k >= 0; k--) {
        if (delims[k].ch !== '[') continue;
        oi = k;
        break;
      }
      if (oi >= 0) {
        const opener = delims[oi];
        if (!opener.isImage && opener.pos <= lastLinkOpenPos) {
          // blocked: cannot form a link; deactivate it
          delims.splice(oi, 1);
          resolveDeferredClosers();
          oi = -1;
        }
      }
      if (oi < 0) {
        // No usable opener: no link can form at this ]. Any emphasis
        // closers deferred inside a failed link attempt become resolvable.
        resolveDeferredClosers();
      }
      if (oi >= 0) {
        const opener = delims[oi];
        const link = tryParseLink(text, opener.openPos, i, refs, opener.isImage);
        if (link) {
          // build the link: the text between opener and ] is the link text
          const linkText = text.slice(opener.openPos + 1, i);
          // Unpaired backtick runs in the link text suppress a later
          // emphasis closer (marked #n masking); record their lengths
          // (first link with leftovers wins; a consumed set can be set
          // again by a later link).
          if (pendingTickLens.size === 0) {
            const left = leftoverTickLens(linkText);
            if (left.size > 0) pendingTickLens = left;
          }
          const inner = opener.isImage ? plainText(linkText, refs) : inline(linkText, refs, true);
          const dest = escapeAttr(encodeNonAscii(link.dest));
          const title = link.title !== null ? ' title="' + escapeAttr(link.title) + '"' : '';
          flush(opener.pos);
          // remove the opener chunk and everything after it up to i, replace with the link
          // out currently holds chunks up to litStart (which is i, since the ] is at i)
          // We need to drop the opener chunk and the chunks after it (the link text chunks),
          // then push the link HTML.
          // The opener chunk is at out index opener.idx. Remove out[opener.idx..end].
          out.length = opener.idx;
          if (opener.isImage) {
            out.push('<img src="' + dest + '" alt="' + escapeAttr(inner) + '"' + title + '>');
          } else {
            out.push('<a href="' + dest + '"' + title + '>' + inner + '</a>');
          }
          // remove the opener and any delimiters after it from the stack
          delims.splice(oi);
          // A link (not an image) inside a potential outer link blocks the
          // outer [ from forming a link; an image does not.
          if (!opener.isImage) lastLinkOpenPos = opener.openPos;
          i = link.end;
          litStart = i;
          continue;
        }
        // not a link: deactivate this opener (it cannot form a link later).
        // The [ is now literal text, so emphasis closers that were deferred
        // inside it become resolvable — UNLESS the [...] (...) region is
        // masked (blockSkip shape): then emphasis inside it never forms
        // (marked #n masking; doc-16/20, [foo *bar*](bad dest)).
        // For an image opener the ! was never emitted, so restore it in
        // front of the [.
        if (opener.isImage) out[opener.idx] = '![';
        if (maskedBracket(text, opener.openPos, i)) {
          for (let d = 0; d < delims.length; d++) {
            const dd = delims[d];
            if (dd.pos > opener.openPos && dd.pos < i && (dd.ch === '*' || dd.ch === '_' || dd.ch === '~')) {
              dd.canOpen = false;
              dd.dead = true;
            }
          }
        }
        delims.splice(oi, 1);
        resolveDeferredClosers();
      }
      i++;
      continue;
    }
    // GFM extended autolinks (www. / scheme / mailto: / bare email).
    // Suppressed inside link text (a bare URL there is plain text);
    // the re-parse of a formed link's text handles that. During the
    // initial scan autolinks still match eagerly so a failed [ keeps
    // its autolink. A ] followed by ( ends the URL only when the
    // enclosing [ can still form a link (nearestBracketCanForm).
    // Also suppressed inside a raw <a> element (no nested anchors).
    if (!inLink && !inAnchor && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57))) {
      let hasOpenUnderscore = false;
      for (let d = delims.length - 1; d >= 0; d--) if (delims[d].ch === '_' && delims[d].canOpen) { hasOpenUnderscore = true; break; }
      const al = matchGfmAutolink(text, i, nearestBracketCanForm(), hasOpenUnderscore);
      if (al) {
        flush(i);
        out.push(al.html);
        i = al.end;
        litStart = i;
        continue;
      }
      i++;
      continue;
    }
    // newline: hard break (2+ spaces before) or soft break
    if (c === 10) {
      let sp = 0, k = i - 1;
      while (k >= litStart && text.charCodeAt(k) === 32) { sp++; k--; }
      flush(i);
      if (sp >= 2) {
        // remove the trailing spaces from the last output chunk
        const last = out[out.length - 1];
        if (last && typeof last === 'string') out[out.length - 1] = last.slice(0, last.length - sp);
        out.push('<br>');
        // after a hard break the next line's leading spaces are stripped
        let j = i + 1;
        while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
        i = j;
      } else {
        out.push('\n');
        i++;
      }
      litStart = i;
      continue;
    }
    i++;
  }
  flush(n);
  return out.join('');
}

// ------------------------------------------------- inline helpers
function isTagNameChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
}

// Match an inline HTML tag starting at i (s[i] === '<'). Returns the end
// index (exclusive) or 0.
function matchHtmlTag(s, i) {
  const n = s.length;
  if (i + 1 >= n) return 0;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 33) {
    if (s.startsWith('<!--', i)) {
      // <!--> and <!---> are complete (abruptly closed) comments
      if (s.startsWith('<!-->', i)) return i + 5;
      if (s.startsWith('<!--->', i)) return i + 6;
      const e = s.indexOf('-->', i + 4);
      return e >= 0 ? e + 3 : 0;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      return e >= 0 ? e + 3 : 0;
    }
    if (i + 2 < n && ((s.charCodeAt(i + 2) >= 65 && s.charCodeAt(i + 2) <= 90) || (s.charCodeAt(i + 2) >= 97 && s.charCodeAt(i + 2) <= 122))) {
      const e = s.indexOf('>', i + 2);
      return e >= 0 ? e + 1 : 0;
    }
    return 0;
  }
  if (c1 === 63) {
    const e = s.indexOf('?>', i + 2);
    return e >= 0 ? e + 2 : 0;
  }
  if (c1 === 47) {
    let j = i + 2;
    if (j >= n || !((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122))) return 0;
    while (j < n && isTagNameChar(s.charCodeAt(j))) j++;
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
    if (j < n && s.charCodeAt(j) === 62) return j + 1;
    return 0;
  }
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return 0;
  let j = i + 1;
  while (j < n && isTagNameChar(s.charCodeAt(j))) j++;
  // attributes. sawWs persists across iterations: the whitespace skipped
  // after a boolean attribute name counts for the next attribute.
  let sawWs = false;
  while (true) {
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) { j++; sawWs = true; }
    if (j >= n) return 0;
    const cj = s.charCodeAt(j);
    if (cj === 62) return j + 1;
    if (cj === 47) {
      if (j + 1 < n && s.charCodeAt(j + 1) === 62) return j + 2;
      return 0;
    }
    if (!sawWs) return 0; // an attribute must be preceded by whitespace
    sawWs = false;
    // attribute name: [a-zA-Z_:][a-zA-Z0-9_.:-]*
    const aStart = j;
    const c0 = s.charCodeAt(j);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95 || c0 === 58)) return 0;
    j++;
    while (j < n) {
      const ca = s.charCodeAt(j);
      if ((ca >= 65 && ca <= 90) || (ca >= 97 && ca <= 122) || (ca >= 48 && ca <= 57) || ca === 95 || ca === 45 || ca === 46 || ca === 58) j++;
      else break;
    }
    if (j === aStart) return 0;
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) { j++; sawWs = true; }
    if (j < n && s.charCodeAt(j) === 61) {
      j++;
      while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
      if (j >= n) return 0;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        const e = s.indexOf(String.fromCharCode(q), j);
        if (e < 0) return 0;
        j = e + 1;
      } else {
        while (j < n) {
          const ca = s.charCodeAt(j);
          if (ca === 32 || ca === 9 || ca === 10 || ca === 62) break;
          if (ca === 34 || ca === 39 || ca === 60 || ca === 61 || ca === 96) return 0;
          j++;
        }
      }
    }
  }
}

function isEmailLocalChar(c) {
  // marked's GFM email local part is [A-Za-z0-9._+-] only (NOT the
  // broader RFC atext set): me!tag@example.com links just
  // tag@example.com, and foo/bar@baz.qux links just bar@baz.qux.
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
    c === 46 || c === 95 || c === 43 || c === 45;
}

// Match <scheme:...> or <email> starting at i (s[i] === '<').
function matchAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 62) break;
    if (c === 32 || c === 9 || c === 10 || c === 60) return null;
    j++;
  }
  if (j >= n) return null;
  const content = s.slice(i + 1, j);
  if (content.length === 0) return null;
  const colon = content.indexOf(':');
  if (colon >= 1) {
    const scheme = content.slice(0, colon);
    if (scheme.length >= 2 && scheme.length <= 32 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) {
      const href = escapeAttr(encodeNonAscii(content.replace(/\\/g, '%5C').replace(/`/g, '%60').replace(/\]/g, '%5D').replace(/\[/g, '%5B')));
      return { html: '<a href="' + href + '">' + escapeText(content) + '</a>', end: j + 1 };
    }
  }
  const at = content.indexOf('@');
  if (at > 0) {
    const domain = content.slice(at + 1);
    if (/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(content.slice(0, at)) &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(domain)) {
      const href = escapeAttr('mailto:' + content);
      return { html: '<a href="' + href + '">' + escapeText(content) + '</a>', end: j + 1 };
    }
  }
  return null;
}

// Parse (dest title) of an inline link starting at the '(' at index i.
// Returns {dest, title, end} (end = index after ')') or null.
function parseInlineParens(s, i) {
  const n = s.length;
  let p = i + 1;
  while (p < n && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9 || s.charCodeAt(p) === 10)) p++;
  let dest = '';
  if (p < n && s.charCodeAt(p) === 60) {
    // angle destination: ends at the first unescaped '>'; a '<' inside
    // invalidates it (the dest cannot contain a tag).
    let gt = -1;
    for (let q = p + 1; q < n; q++) {
      const cq = s.charCodeAt(q);
      if (cq === 92 && q + 1 < n && isAsciiPunct(s.charCodeAt(q + 1))) { q++; continue; }
      if (cq === 60) return null;
      if (cq === 62) { gt = q; break; }
      if (cq === 10) break;
    }
    if (gt < 0) return null;
    dest = unescapeBackslash(s.slice(p + 1, gt)).replace(/\\/g, '%5C').replace(/ /g, '%20').replace(/"/g, '%22');
    p = gt + 1;
  } else {
    let depth = 0;
    let q = p;
    while (q < n) {
      const cq = s.charCodeAt(q);
      if (cq === 32 || cq === 9 || cq === 10) break;
      if (cq < 32) return null;
      if (cq === 40) depth++;
      else if (cq === 41) {
        if (depth === 0) break;
        depth--;
      } else if (cq === 92 && q + 1 < n && isAsciiPunct(s.charCodeAt(q + 1))) {
        q += 2;
        continue;
      }
      q++;
    }
    dest = unescapeBackslash(s.slice(p, q)).replace(/\\/g, '%5C').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/"/g, '%22');
    p = q;
  }
  // After the dest, a title must be separated by whitespace (a space/tab/
  // newline). A title quote directly after the dest is not a title.
  const destEnd = p;
  while (p < n && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9 || s.charCodeAt(p) === 10)) p++;
  if (p < n && s.charCodeAt(p) === 41) return { dest, title: null, end: p + 1 };
  // title (must be separated from the dest by whitespace)
  let title = null;
  if (p < n) {
    const qc = s.charCodeAt(p);
    if (qc === 34 || qc === 39 || qc === 40) {
      if (p === destEnd) return null; // no whitespace before the title
      if (qc === 40) {
        const e = s.indexOf(')', p + 1);
        if (e < 0) return null;
        title = unescapeBackslash(s.slice(p + 1, e));
        p = e + 1;
      } else {
        const quote = String.fromCharCode(qc);
        // scan for the closing quote, skipping backslash escapes
        let e = -1;
        for (let q = p + 1; q < n; q++) {
          if (s.charCodeAt(q) === 92 && q + 1 < n) { q++; continue; }
          if (s.charCodeAt(q) === qc) { e = q; break; }
        }
        if (e < 0) return null;
        title = unescapeBackslash(s.slice(p + 1, e));
        p = e + 1;
      }
    } else return null;
  } else return null;
  while (p < n && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9 || s.charCodeAt(p) === 10)) p++;
  if (p < n && s.charCodeAt(p) === 41) return { dest, title, end: p + 1 };
  return null;
}

// Try to parse a link whose [ is at openPos and whose ] is at closePos.
// Returns {dest, title, end} or null.
function tryParseLink(s, openPos, closePos, refs, isImage) {
  const n = s.length;
  const after = closePos + 1;
  // The link text must match marked's label pattern in EVERY form
  // (inline, full/collapsed reference, shortcut): code-span runs must
  // pair up. An invalid label can never form a link (doc-16, doc-18,
  // [a ``b ` c`` d]).
  if (!validLabel(s.slice(openPos + 1, closePos))) return null;
  if (after < n && s.charCodeAt(after) === 40) {
    const inl = parseInlineParens(s, after);
    if (inl) return inl;
    // Inline link failed (e.g. dest with spaces): fall back to the
    // shortcut reference [text] and leave (...) as literal text.
  }
  if (after < n && s.charCodeAt(after) === 91) {
    // collapsed reference [text][] — the label is the link text itself
    if (after + 1 < n && s.charCodeAt(after + 1) === 93) {
      const labelText = s.slice(openPos + 1, closePos);
      if (labelText.length === 0 || labelText.length > 999) return null;
      const norm = normalizeLabel(labelText);
      if (!norm) return null;
      const ref = refs.get(norm);
      if (!ref) return null;
      return { dest: ref.dest, title: ref.title, end: after + 2 };
    }
    // full reference [text][label]
    let p = after + 1;
    let label = '';
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 93) break;
      if (c === 92 && p + 1 < n) { label += s[p] + s[p + 1]; p += 2; continue; }
      if (c === 91 || c === 10) return null;
      label += s[p];
      p++;
    }
    if (p >= n || label.length === 0 || label.length > 999) return null;
    const norm = normalizeLabel(label);
    if (!norm) return null;
    const ref = refs.get(norm);
    if (!ref) return null;
    return { dest: ref.dest, title: ref.title, end: p + 1 };
  }
  // shortcut reference [text]
  {
    const labelText = s.slice(openPos + 1, closePos);
    if (labelText.length === 0 || labelText.length > 999) return null;
    const norm = normalizeLabel(labelText);
    if (!norm) return null;
    const ref = refs.get(norm);
    if (!ref) return null;
    return { dest: ref.dest, title: ref.title, end: closePos + 1 };
  }
}

// Plain text of a link/image text (for alt): formatting markers removed,
// code span content kept, link text flattened, HTML tags kept as literal.
function plainText(text, refs) {
  let r = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      const nc = text.charCodeAt(i + 1);
      if (nc === 10) { r += '\n'; i += 2; continue; }
      if (isAsciiPunct(nc)) { r += String.fromCharCode(nc); i += 2; continue; }
      r += text[i]; i++; continue;
    }
    if (c === 96) {
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const ticks = j - i;
      let k = j, close = -1;
      while (k < n) {
        if (text.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && text.charCodeAt(m) === 96) m++;
          if (m - k === ticks) { close = k; break; }
          k = m;
        } else k++;
      }
      if (close < 0) { r += text.slice(i, j); i = j; continue; }
      let content = text.slice(j, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && !/^[ ]+$/.test(content)) content = content.slice(1, -1);
      r += content;
      i = close + ticks;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) {
      let j = i;
      while (j < n && text.charCodeAt(j) === c) j++;
      const len = j - i;
      const { leftFlanking, rightFlanking } = flankInfo(text, i, len);
      let canOpen, canClose;
      if (c === 42) { canOpen = leftFlanking; canClose = rightFlanking; }
      else if (c === 95) { canOpen = leftFlanking && (!rightFlanking || isPunctCode(i > 0 ? text.charCodeAt(i - 1) : -1)); canClose = rightFlanking && (!leftFlanking || isPunctCode(i + len < n ? text.charCodeAt(i + len) : -1)); }
      else { canOpen = leftFlanking; canClose = rightFlanking; }
      if (canOpen || canClose) { i = j; continue; }
      r += text.slice(i, j); i = j; continue;
    }
    if (c === 60) {
      const tagEnd = matchHtmlTag(text, i);
      if (tagEnd > 0) { r += text.slice(i, tagEnd); i = tagEnd; continue; }
      const al = matchAutolink(text, i);
      if (al) {
        const gt = text.indexOf('>', i);
        r += text.slice(i + 1, gt);
        i = al.end;
        continue;
      }
      r += text[i]; i++; continue;
    }
    if (c === 91 || (c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91)) {
      const openPos = c === 91 ? i : i + 1;
      const close = text.indexOf(']', openPos + 1);
      if (close < 0) { r += text[i]; i++; continue; }
      const link = tryParseLink(text, openPos, close, refs, c === 33);
      if (link) {
        r += plainText(text.slice(openPos + 1, close), refs);
        i = link.end;
        continue;
      }
      r += text[i]; i++; continue;
    }
    r += text[i];
    i++;
  }
  return r;
}

// Scan a GFM bare URL starting at i. Returns the trimmed URL or null.
function scanGfmUrl(s, i, stopBracket) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c === 34 || c === 96) break;
    // A '(' is URL text only when it has a matching ')' before the next
    // whitespace (balanced parens); otherwise the URL ends before it.
    if (c === 40) {
      let depth = 0, k = j, ok = false;
      while (k < n) {
        const ck = s.charCodeAt(k);
        if (ck === 32 || ck === 9 || ck === 10 || ck === 60 || ck === 62 || ck === 34 || ck === 96) break;
        if (ck === 40) depth++;
        else if (ck === 41) { depth--; if (depth === 0) { ok = true; break; } }
        k++;
      }
      if (!ok) break;
    }
    // A ] is a link's closing bracket, not part of the URL — but only
    // when the enclosing [ can still form a link AND a link follows the
    // ] (an inline dest '(' or a reference label '['). When that [ is
    // blocked or absent, or no link follows, the ] is ordinary URL
    // text (a ( after it is then governed by the balanced-paren rule
    // above).
    if (stopBracket && c === 93 && j + 1 < n && (s.charCodeAt(j + 1) === 40 || s.charCodeAt(j + 1) === 91)) break;
    // A & that starts an entity-like &name; ends the URL (the entity is
    // separate text, e.g. www.x/?q=a&hl; links only up to the &).
    if (c === 38) {
      let k = j + 1;
      while (k < n) {
        const ck = s.charCodeAt(k);
        if ((ck >= 65 && ck <= 90) || (ck >= 97 && ck <= 122) || (ck >= 48 && ck <= 57)) k++;
        else break;
      }
      if (k > j + 1 && k < n && s.charCodeAt(k) === 59) break;
    }
    j++;
  }
  let url = s.slice(i, j);
  if (url.length === 0) return null;
  let open = 0, close = 0;
  for (let k = 0; k < url.length; k++) {
    if (url.charCodeAt(k) === 40) open++;
    // A ) immediately followed by ] is part of a )] link-bracket
    // sequence, not a paren-group close; it does not count for balance.
    else if (url.charCodeAt(k) === 41 && !(k + 1 < url.length && url.charCodeAt(k + 1) === 93)) close++;
  }
  // Trim trailing unbalanced ) and trailing punctuation/underscores/
  // asterisks/tildes in one loop: trimming a '.' can expose a ')'
  // that must then be trimmed.
  while (url.length > 0) {
    const c = url.charCodeAt(url.length - 1);
    if (c === 41 && close > open) { url = url.slice(0, -1); close--; continue; }
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 63 || c === 33 || c === 95 || c === 42 || c === 126) { url = url.slice(0, -1); continue; }
    break;
  }
  return url.length > 0 ? url : null;
}

// Scan a bare email starting at i. Returns the email or null.
function scanEmail(s, i, hasOpenUnderscore) {
  const n = s.length;
  let j = i;
  while (j < n && isEmailLocalChar(s.charCodeAt(j))) j++;
  if (j === i || j >= n || s.charCodeAt(j) !== 64) return null;
  const at = j;
  j++;
  const dStart = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46) j++;
    // An internal '_' (followed by a letter/digit) is part of the
    // address: me@example.com_foo links as one address.
    else if (c === 95 && j + 1 < n && ((s.charCodeAt(j + 1) >= 65 && s.charCodeAt(j + 1) <= 90) || (s.charCodeAt(j + 1) >= 97 && s.charCodeAt(j + 1) <= 122) || (s.charCodeAt(j + 1) >= 48 && s.charCodeAt(j + 1) <= 57))) j++;
    else break;
  }
  if (j === dStart) return null;
  let domain = s.slice(dStart, j);
  // A trailing '-' makes the domain invalid (a label cannot end with -);
  // a trailing '.' is a sentence period and is trimmed.
  if (domain.charCodeAt(domain.length - 1) === 45) return null;
  while (domain.length > 0 && domain.charCodeAt(domain.length - 1) === 46) domain = domain.slice(0, -1);
  if (domain.indexOf('.') < 0) return null;
  if (domain.charCodeAt(0) === 46 || domain.charCodeAt(0) === 45) return null;
  if (domain.indexOf('..') >= 0) return null;
  // A '_' directly after the domain: it ends the address (the '_' is
  // an emphasis delimiter) but only when an underscore opener is on
  // the delimiter stack; otherwise the address is invalid
  // (me@example.com_, me@example.com_foo_ and me@example.com__ do not
  // link).
  if (j < n && s.charCodeAt(j) === 95) {
    if (hasOpenUnderscore) return s.slice(i, at + 1) + domain;
    return null;
  }
  return s.slice(i, at + 1) + domain;
}

function isGfmPreceding(c) {
  return c === 32 || c === 9 || c === 10 || c === 40 || c === 42 || c === 95 || c === 126;
}

// Ot-neutralisation (marked #n, first step): inside a code span
// (greedy match from a backtick run to the next run of the same length)
// backticks become '+'; a backslash + punctuation becomes '++' (same
// length). Lone backtick runs are left unchanged. Length is preserved,
// so positions still line up with the original text.
function otNeutralize(s) {
  const n = s.length;
  const out = [];
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n) { out.push('++'); i += 2; continue; }
    if (c === 96) {
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const len = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (s.charCodeAt(k) === 92 && k + 1 < n) { k += 2; continue; }
        if (s.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && s.charCodeAt(m) === 96) m++;
          if (m - k === len) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found >= 0) {
        // a code span: keep the delimiter runs, neutralise backticks
        // inside the content
        const span = s.slice(i, found + len);
        let rebuilt = '';
        for (let q = 0; q < span.length; q++) {
          const cc = span.charCodeAt(q);
          if (cc === 96 && q >= len && q < span.length - len) rebuilt += '+';
          else rebuilt += span[q];
        }
        out.push(rebuilt);
        i = found + len;
        continue;
      }
      out.push(s.slice(i, j));
      i = j;
      continue;
    }
    out.push(s[i]);
    i++;
  }
  return out.join('');
}

// True when the [ ... ] at openPos..closePos, followed by (...),
// matches marked's blockSkip link shape (after Ot-neutralisation):
// the label contains no [ or ] and its backtick runs pair up into
// proper same-length code spans, and the (...) is balanced (at most
// one level of nesting). Such a region is MASKED in marked: emphasis
// inside it never forms, even though the link itself fails to form
// (bad dest, or a label the real link regex rejects, e.g. doc-16's
// `` `` a ` b `` `` label).
function maskedBracket(text, openPos, closePos) {
  const label = otNeutralize(text.slice(openPos + 1, closePos));
  let i = 0;
  const n = label.length;
  while (i < n) {
    const c = label.charCodeAt(i);
    if (c === 91 || c === 93) return false;
    if (c === 96) {
      let j = i;
      while (j < n && label.charCodeAt(j) === 96) j++;
      const len = j - i;
      let k = j;
      while (k < n && label.charCodeAt(k) !== 96) k++;
      if (k >= n) return false;
      let m = k;
      while (m < n && label.charCodeAt(m) === 96) m++;
      if (m - k !== len) return false;
      i = m;
      continue;
    }
    i++;
  }
  // following (...) — balanced, at most one nesting level
  let p = closePos + 1;
  if (p >= text.length || text.charCodeAt(p) !== 40) return false;
  let depth = 0;
  while (p < text.length) {
    const c = text.charCodeAt(p);
    if (c === 92 && p + 1 < text.length) { p += 2; continue; }
    if (c === 40) { depth++; if (depth > 2) return false; }
    else if (c === 41) { depth--; if (depth === 0) return true; }
    p++;
  }
  return false;
}

// True when s is a valid link label per marked's label pattern:
// a sequence of nested [...] (one level), backslash escapes,
// code-span units `+(?!`)[^`]*?`+(?!`) (opening/closing lengths need
// NOT match), `` ``+(?=\]) `` (2+ backticks right before the ]), and
// any char except [, ], \ and backtick. In particular a label whose
// code-span runs do not pair up (e.g. doc-16's `` `` a ` b `` ``,
// or [a ``b ` c`` d]) is invalid and the link does not form.
function validLabel(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 >= n) return false;
      i += 2;
      continue;
    }
    if (c === 91) {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (s.charCodeAt(i) === 92 && i + 1 < n) { i += 2; continue; }
        if (s.charCodeAt(i) === 91) depth++;
        else if (s.charCodeAt(i) === 93) depth--;
        i++;
      }
      if (depth !== 0) return false;
      continue;
    }
    if (c === 93) return false;
    if (c === 96) {
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const len = j - i;
      // `` ``+(?=\]) `` — 2+ backticks right before the end of the label
      if (len >= 2 && j === n) { i = j; continue; }
      // code-span unit: a later backtick run (any length) closes it
      let k = j;
      while (k < n && s.charCodeAt(k) !== 96) k++;
      if (k >= n) return false;
      let m = k;
      while (m < n && s.charCodeAt(m) === 96) m++;
      i = m;
      continue;
    }
    i++;
  }
  return true;
}

// Lengths of backtick runs in s that are not part of a properly-formed
// code span (exact-length opener/closer pairs; runs inside a span's
// content are consumed by the span). Used for the emphasis suppression
// after a link whose text contains unpaired backticks (marked #n
// masking).
function leftoverTickLens(s) {
  const left = new Set();
  const n = s.length;
  let i = 0;
  while (i < n) {
    // A backslash escapes the next character (notably \`): an escaped
    // backtick is not a backtick run (marked's masking neutralises
    // \(punct); doc-07's link text contains \` which must not create
    // a leftover run.
    if (s.charCodeAt(i) === 92 && i + 1 < n) { i += 2; continue; }
    if (s.charCodeAt(i) === 96) {
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const len = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (s.charCodeAt(k) === 92 && k + 1 < n) { k += 2; continue; }
        if (s.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && s.charCodeAt(m) === 96) m++;
          if (m - k === len) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found >= 0) { i = found + len; continue; }
      left.add(len);
      i = j;
    } else i++;
  }
  return left;
}

// GFM extended autolink at position i. Returns {html, end} or null.
// hasOpenUnderscore: an unmatched '_' opener is on the delimiter stack,
// so a '__' after an email domain is its closer, not part of the address.
function matchGfmAutolink(s, i, stopBracket, hasOpenUnderscore) {
  const n = s.length;
  const c = s.charCodeAt(i);
  // www. — restricted preceding char (start, whitespace, (, *, _, ~)
  if (c === 119 || c === 87) {
    if (s.startsWith('www.', i) || s.startsWith('WWW.', i)) {
      if (i > 0 && !isGfmPreceding(s.charCodeAt(i - 1))) return null;
      const url = scanGfmUrl(s, i, stopBracket);
      if (url && url.indexOf('.') > 0) {
        const href = 'http://' + encodeNonAscii(url.replace(/]/g, '%5D').replace(/\\/g, '%5C').replace(/`/g, '%60'));
        return { html: '<a href="' + escapeAttr(href) + '">' + escapeText(url) + '</a>', end: i + url.length };
      }
      return null;
    }
  }
  // mailto: — validated as an email address
  if (c === 109 || c === 77) {
    const lower = s.slice(i, i + 7).toLowerCase();
    if (lower === 'mailto:') {
      const email = scanEmail(s, i + 7, hasOpenUnderscore);
      if (email) {
        const full = s.slice(i, i + 7 + email.length);
        return { html: '<a href="' + escapeAttr(full) + '">' + escapeText(full) + '</a>', end: i + 7 + email.length };
      }
      return null;
    }
  }
  // Schemes (marked's GFM url rule): only http://, https://, ftp://
  // (case-insensitive, :// required) link as URLs, and xmpp: + email
  // (with at most one path segment). Any other scheme does NOT
  // autolink (foo:bar.baz, config:foo.bar, ssh://..., git://...,
  // tel:+123 are all plain text) — but the email part alone may still
  // link via the bare-email branch below (custom:foo@bar.baz links
  // just foo@bar.baz). A scheme must start at a word boundary (not
  // preceded by a letter/digit, so mailto: does not yield a bogus
  // ailto: link when its email is invalid).
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
    if (i > 0) {
      const pc = s.charCodeAt(i - 1);
      if ((pc >= 65 && pc <= 90) || (pc >= 97 && pc <= 122) || (pc >= 48 && pc <= 57)) return null;
    }
    let k = i;
    while (k < n) {
      const ck = s.charCodeAt(k);
      if ((ck >= 65 && ck <= 90) || (ck >= 97 && ck <= 122) || (ck >= 48 && ck <= 57) || ck === 43 || ck === 45 || ck === 46) k++;
      else break;
    }
    const schemeLen = k - i;
    if (schemeLen >= 2 && schemeLen <= 32 && k < n && s.charCodeAt(k) === 58) {
      const scheme = s.slice(i, k).toLowerCase();
      if (scheme === 'http' || scheme === 'https' || scheme === 'ftp') {
        if (s.charCodeAt(k + 1) === 47 && s.charCodeAt(k + 2) === 47) {
          const url = scanGfmUrl(s, i, stopBracket);
          if (url && url.length > schemeLen + 3) {
            const href = encodeNonAscii(url.replace(/]/g, '%5D').replace(/\\/g, '%5C').replace(/`/g, '%60'));
            return { html: '<a href="' + escapeAttr(href) + '">' + escapeText(url) + '</a>', end: i + url.length };
          }
        }
        return null;
      }
      if (scheme === 'xmpp') {
        const email = scanEmail(s, k + 1, hasOpenUnderscore);
        if (email) {
          let end = k + 1 + email.length;
          if (end < n && s.charCodeAt(end) === 47) {
            let p = end + 1;
            while (p < n) {
              const cp = s.charCodeAt(p);
              if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57) || cp === 64 || cp === 46) p++;
              else break;
            }
            if (p > end + 1) end = p;
          }
          const full = s.slice(i, end);
          return { html: '<a href="' + escapeAttr(full) + '">' + escapeText(full) + '</a>', end };
        }
        return null;
      }
      // any other scheme: not a link — fall through to the bare-email
      // branch below so an email after the colon can still link.
    }
  }
  // bare email — must be at a word boundary
  if (i > 0 && isEmailLocalChar(s.charCodeAt(i - 1))) return null;
  const email = scanEmail(s, i, hasOpenUnderscore);
  if (email) {
    return { html: '<a href="' + escapeAttr('mailto:' + email) + '">' + escapeText(email) + '</a>', end: i + email.length };
  }
  return null;
}
