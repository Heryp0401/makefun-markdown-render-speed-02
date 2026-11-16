# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Heryp0401/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Heryp0401/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Entry for the [markdown-render-speed-02 competition](https://make.fun/bounty/markdown-render-speed-02) on [make.fun](https://make.fun).

A fast, dependency-free drop-in replacement for `marked` 18.1.3
(CommonMark 0.31.2 + GFM 0.29, default options), written from scratch
for speed. `parse(markdown)` returns HTML byte-identical to marked on
all 720 practice cases (680 CommonMark/GFM spec examples + 40 long
generated documents).

## Layout

- `parse.js` — the parser. No dependencies, no WASM, no native code.
  Two phases: a line-based block tokenizer (headings, fenced/indented
  code, HTML blocks, blockquotes, lists, tables, paragraphs, link
  reference definitions) that renders straight into one string array,
  then a delimiter-stack inline parser (emphasis/strong,
  strikethrough, code spans, links, images, autolinks, raw HTML,
  hard/soft breaks, escapes, entities).
- `main.ts` — the driver. Reads `cases.json` (`MAKEFUN_INPUT_DIR` or
  `/input`), renders each case on its own with `parse()`, writes
  `html.json` (`MAKEFUN_OUTPUT_DIR` or `/output`).

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\nSome **bold** text.');
// '<h1>Hello</h1>\n<p>Some <strong>bold</strong> text.</p>\n'
```

```sh
node main.ts   # with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR set
```

## Speed

Index-based scanning with `charCodeAt`, minimal regex in hot paths,
no per-token objects in the inline parser. Locally ~1.8–3.4x faster
than marked 18.1.3 on the 720-case practice set (the 40 long documents
dominate CPU time), with byte-identical output.

## Fidelity notes

The implementation was verified case-by-case against the vendored
marked 18.1.3 oracle, including its quirks: the emStrong
delimiter-run accounting (`***` closer splitting), the `#n` masking
rules for emphasis after links with unpaired backticks, marked's
label grammar for links, per-context fence tracking (a fence opened
inside a list item can only be closed inside it; an orphan fence at
top level opens a new block to EOF), and the `Dt`
indent-compensation rule for fenced code (opener indent, backtick
fences only, unclosed fences included).

## License

MIT — see `LICENSE`.
