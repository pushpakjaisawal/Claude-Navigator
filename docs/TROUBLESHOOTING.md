# Troubleshooting & bug reporting

## 1. First step for any problem: copy the Diagnostics report
Sidebar → **gear** → **Diagnostics**. It copies a JSON report to the clipboard (and prints it in the browser console
under `[Claude Navigator] diagnostics`). It contains page structure only — **no message text**, chat id redacted.

### Reading the report
| Field | Healthy value | If it differs |
|---|---|---|
| `version` | the version you installed | You are running an old copy: remove the extension, load the new folder, hard-reload (Ctrl+Shift+R). |
| `mode` | `"api"` | `"dom"` → the conversation data could not be read (endpoint changed / not logged in / blocked). See §2 "Badge says Page only". |
| `items` | total messages in the chat | `0` on a chat page → loading failed; press **Reload** in settings. |
| `boundToPage` | `2`–`10` (rows currently rendered) | `0` while `domUserMsgs`/`domAsstMsgs` are also `0` → message selectors no longer match (see §2). |
| `domUserMsgs`, `domAsstMsgs` | ≥ 1 | `0` → `CFG.SEL` needs updating. |
| `scroller.h` vs `scroller.ch` | `h` much larger than `ch` (e.g. 86,000 vs 587) | `h ≈ ch` → wrong element chosen as the scroller; jumps will do nothing. |
| `speed` | 1–10 | — |
| `testids` | contains `transcript-list`, `user-message`, `assistant-message` | Missing ones show what claude.ai renamed. Compare with `docs/ARCHITECTURE.md` §7. |
| `lastJump` | `null` (no jump yet) or `{found:true, steps:2–8}` | `found:false` + large `steps` → jump gave up. `error:"…"` → a code exception (send the whole report). |
| `ua` | your browser | — |

## 2. Symptom → cause → fix
| Symptom | Likely cause | What to do |
|---|---|---|
| Sidebar never appears | Extension not loaded / old tab | `chrome://extensions` → enabled? Reload claude.ai (Ctrl+Shift+R). Try the round button / `Alt+Shift+N`. |
| `Alt+Shift+N` does nothing | Another extension owns the combo | `chrome://extensions/shortcuts` → set your own. (`Ctrl+Shift+N` is reserved by Chrome and can never work.) |
| Outline empty on a chat page | Data load failed and the page has no recognisable messages | Gear → **Reload**. Run Diagnostics; check `mode`, `domUserMsgs`. |
| Badge says **Page only** | `/api/…` request failed (not logged in, endpoint/fields changed, network policy) | Gear → Reload. Open DevTools → Network, filter `chat_conversations`, check the status code. If it is 200 but the badge stays amber, the response shape changed → update `parseConversation`. The extension still works for messages that are on the page. |
| Outline shows only the newest messages | Same as above (Page only) | Same as above. |
| Click does nothing, no message | Exception in the click path | DevTools Console: look for `[Claude Navigator] jump failed`. Run Diagnostics → `lastJump.error`. |
| Toast "Couldn't reach that message" | The loop gave up (scroller not moving, or the message never rendered) | Try again (position estimate improves each time). If always: Diagnostics → `scroller` is wrong, or `boundToPage` is 0. |
| Jump lands on a different message | Two messages look alike and alignment was ambiguous | Report with the two message openings (not full text). Alignment is in `bind()`; text fallback is in `locateByText`. |
| Jump is slow | Speed setting or very long chat | Gear → raise **Scroll speed**. 10 = instant. |
| Page keeps moving while I try to read | Scroll-spy/jump fighting you | Scroll or touch the chat: it cancels the jump immediately. If the *outline* jumps while you scroll it, report it (scroll-spy bug). |
| Eye does not open / does not close | Click not reaching the button | Eye is a toggle: first tap shows, second tap on the **same** eye hides. `Esc` and ✕ also close. Report with Diagnostics if it never opens. |
| Reader opened by itself | Should be impossible (invariant 4) | Report immediately with the steps; the test suite covers this. |
| Search finds nothing | Only the *current branch* is indexed; tool-only turns are skipped | Expected. |
| Export is missing a message | Same as above | Expected. |
| Wrong colours (light on dark) | claude.ai changed how it marks dark mode | Add the new selector to the `--cn-*` block in `sidebar.css`. |
| Popup shows no recent chats | Chats are recorded when you open a conversation with the sidebar active | Open a chat; check `chrome.storage.local.cn_index` in the service-worker console. |

## 3. Quick console probes (DevTools on claude.ai)
```js
// Do the selectors match anything?
document.querySelectorAll('[data-testid="user-message"]').length
document.querySelectorAll('[data-testid="assistant-message"]').length
// Which element scrolls the chat?
[...document.querySelectorAll('div')].filter(e=>/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight>e.clientHeight+50)
  .map(e=>({cls:e.className.slice(0,60), h:e.scrollHeight, ch:e.clientHeight}))
// Is the data endpoint reachable? (replace ORG and CHAT)
fetch('/api/organizations').then(r=>r.json()).then(console.log)
```
Extension logs are prefixed `[Claude Navigator]`. Service-worker logs: `chrome://extensions` → *service worker*.

## 4. Bug-report template (paste into an issue, or to Claude)
```
Claude Navigator version: (from Diagnostics)
Browser / OS:
Chat length (approx. messages):
What I did (exact clicks/keys):
What I expected:
What happened instead:
Happens: always / sometimes / only on very long chats / only after switching chats
Console errors (lines starting [Claude Navigator] or red errors from content.js):
Diagnostics report: (paste the JSON)
```

## 5. How to hand a bug to Claude (so it can fix it fast)
1. Attach the project zip (or the folder contents) **and** paste the Diagnostics JSON and the template above.
2. Say which file you suspect or "I don't know".
3. Ask for: *"Reproduce it in the test harness first (`tests/`), then fix, then add a regression test, and update CHANGELOG.md."*
4. Point Claude at `docs/ARCHITECTURE.md` (§7 dependencies, §8 invariants) — most bugs are one of those.

Useful prompt:
> This is a Chrome extension for claude.ai (see README.md and docs/ARCHITECTURE.md). Bug: <describe>. Diagnostics: <paste>.
> Reproduce with the harness in tests/ (use `selectorless`, `apiDown`, `renderDelay` options if relevant), fix it without
> breaking the invariants in ARCHITECTURE.md §8, add a regression test, run `node tests/run.js`, bump the version and
> update CHANGELOG.md.

## 6. Post-mortems — bugs we have already hit
| Version | Symptom | Root cause | Prevention |
|---|---|---|---|
| 3.0–3.1 | Old/long chats not loaded | Only rendered messages were read; claude.ai virtualizes | Source of truth is the conversation data (§1) |
| 3.2 | Click did nothing | Message lookup relied on claude.ai class names | Text-based fallback; `CFG.SEL` in one place |
| 3.3 | Click did nothing, silently | Scroll-spy listened to the outline's own scrolling and reset the active row; rows re-rendered between mouse-down/up | Spy ignores own UI; render key reuses rows; errors surface as toasts |
| 3.3 | Every click crashed | `setStatus is not defined` (helper deleted in a refactor) | Test suite type-checks for undefined names |
| 3.4 | Jump could not reach rows | Page renders only ~3 rows in a 90,000 px scroller | Estimate → render → correct loop |
| 3.5 | Reader popped up on its own | "Fallback" opened the reader when a jump failed | Reader opens only from the eye (tested) |
| 3.6 | Jump randomly failed on long jumps | Mid-jump re-sync replaced item objects; jump kept a stale copy | Stable item identity; re-resolve by id; regression test |
| 3.6 | Jump landed on look-alike replies | Greedy text match + loose fallback prefix | Offset-vote alignment; fallback returns null if ambiguous |
| 3.0–3.5 | Shortcut never worked | `Ctrl+Shift+N` is reserved by Chrome | `Alt+Shift+N`; test forbids reserved combos |
