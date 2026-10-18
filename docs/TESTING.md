# Testing

## Run
```
node tests/run.js              # everything (≈30 s, no dependencies, Node 18+)
node tests/run.js jump         # only suites/tests whose title contains "jump"
node tests/run.js "eye button"
```
Exit code is non-zero on failure. If the `typescript` package is installed globally, the static-analysis test also
type-checks for undefined names; otherwise it is reported as skipped.

## What the suite covers (10 suites, ~65 tests)
1. **Package & manifest** — valid MV3, claude.ai-only access, referenced files exist, versions agree, no Chrome-reserved shortcut, popup/ID consistency, no external network or remote code.
2. **Static analysis** — undefined identifiers, every `$("id")` exists in markup, every `cn-` class has CSS, no `localStorage`, labels escaped.
3. **Loading** — API source, current branch only, tool-only turns skipped, org fallback, API down → *Page only*, non-chat pages, privacy (only same-origin `/api/`).
4. **Matching** — binding rendered rows to data, repeated prompts, split markdown, locator never reads the sidebar chat list.
5. **Jump** — virtualized transcript (≈3 rows rendered, irregular heights) from both ends at speeds 1/5/10, slow rendering, 1,000 messages, boilerplate look-alike replies, **no selectors at all**, ambiguity refusal, mid-jump re-sync (regression), user-scroll cancel, speed affects duration, failed jump never opens the reader.
6. **Outline** — 5,000 messages stay virtualized, scrolling swaps rows, search/highlight/regex-safety, filters, XSS escaping, performance budget, rows reused when nothing changed.
7. **Eye button** — toggle open/close, switching messages, prev/next/Esc/close/copy, never opens by itself, closes on navigation and jump.
8. **Settings** — default speed 5, slider, clamping, persistence, timing curve, panel open/close, pin, open/closed persistence, keyboard-command message.
9. **Spy & navigation** — no feedback loop from sidebar scrolling, spy follows the chat, SPA navigation, stale responses discarded.
10. **Export & diagnostics** — Markdown/JSON/single message, diagnostics contain no message text, `lastJump` recorded.

## How it works
`tests/harness.js` loads the **real, unmodified** `content.js` into a Node `vm` context wired to `tests/fake-dom.js`
(a small DOM with events, selectors, innerHTML parsing) plus stubs for `chrome.storage`, `fetch`, clipboard, downloads.
It appends one line to the source in memory (`globalThis.__cn = (c) => eval(c)`) so tests can read any internal
variable or call any internal function: `env.cn('items.length')`, `await env.cn('jumpTo("msg-5")')`.

`mountTranscript()` simulates claude.ai's virtualized chat: one tall scroller, only ~3 rows rendered, irregular row
heights, optional render delay, optional `selectorless` markup.

### Harness options
```js
const env = await createEnv({
  messages,            // [{role:'human'|'assistant', text}]  → conversation API payload + rendered transcript
  conversation,        // custom API payload (branches, tool-only turns…)
  orgs, badOrgs,       // organization ids and which ones the API rejects
  apiDown: true,       // every API call fails → fallback mode
  selectorless: true,  // rendered messages have no data-testid (simulates a markup change)
  renderDelay: 40,     // page renders 40 ms after scrollTop changes
  mountPage: false,    // sidebar only (fast UI tests)
  storage: {cn_speed: 8}, pathname: '/chat/abc', autoInit: false,
});
env.page.scrollTop = ...; env.page.topOf(i); env.rows(); env.el('cn-reader'); env.toasts(); env.downloads; env.clipboard;
```
Always call `reg(env)` (the `T` callback argument) so timers are cleaned up.

## Adding a regression test (do this for every bug)
1. Reproduce with the harness in a throwaway script (`CN_SRC=/path/to/instrumented.js node script.js` lets you swap in a
   copy of `content.js` with `console.log` tracing).
2. Add `await T('what must hold', async (reg) => { const env = reg(await createEnv({...})); ... assert... })` to the right suite in `tests/run.js`.
3. **Prove it has teeth**: temporarily re-introduce the bug (copy `content.js` to `/tmp`, edit, run with `CN_SRC=/tmp/x.js node tests/run.js "<test name>"`) and confirm the test fails.
4. Fix, run the whole suite 2–3 times (flaky = bad test), update `CHANGELOG.md`.

## What the suite cannot prove
It is a simulation: no real layout, no real claude.ai, no real Chrome. Therefore also do the **manual check** before
releasing, on a real long chat:
1. Load unpacked, hard-reload claude.ai; badge shows *Full history* and the message count is right.
2. Jump to first, middle, last and a random old message at speeds 1, 5, 10; each lands with a brief highlight.
3. Start a jump, then scroll the chat with the wheel: it stops.
4. Eye on row A shows A; eye on row B switches; eye on B again hides; `Esc` hides.
5. Scroll the chat manually: the reader stays closed.
6. Search a word; filter You/Claude; clear.
7. Gear: change speed, reload page, speed is remembered; Markdown export opens with code blocks intact.
8. Switch to another chat in the left list: outline updates within about a second.
9. Toggle claude.ai light/dark: sidebar follows.
10. `Alt+Shift+N` toggles the sidebar.
If a manual step fails, copy Diagnostics, then reproduce it in the harness and add a test before fixing.
