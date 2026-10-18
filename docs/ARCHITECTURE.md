# Architecture

How Claude Navigator works, what it depends on, and the rules that keep it working.
Read this before changing `content.js`. When something breaks, go to `TROUBLESHOOTING.md`.

## 1. The problem it solves
claude.ai renders long conversations through a **virtualized transcript**: one very tall scroll container
(`overflow-y-auto`, tens of thousands of px) that holds only ~3–10 message rows at any moment. Older and newer
messages are *not in the page*. So an extension that scrapes the page can neither list the whole conversation nor
scroll to a message that is not rendered. Navigator therefore separates two things:

| Concern | Source of truth |
|---|---|
| *What messages exist* (outline, search, export, reader) | claude.ai's conversation data (`items[]`) |
| *Where a message is on screen* (jump, highlight, spy) | the rendered rows, matched to `items[]` by `bind()` |

## 2. Big picture
```
                    ┌──────────────────────────── claude.ai tab ────────────────────────────┐
  /api/organizations/<org>/chat_conversations/<id>                                            │
              │ fetch (same-origin, user's session)                                           │
              ▼                                                                              │
        parseConversation()  ── current branch, text blocks only ──►  items[]                │
                                                                       │  (id, role, text,    │
   rendered rows  ──scanDOM()──►  bind()  ── align rows ↔ items ──►    │   label, sig, el)    │
   [data-testid=user-message|assistant-message]                        │                      │
                                                                       ▼                      │
   sidebar: virtualized outline (view = filter(items)) ◄── applyFilter ┘                      │
        │ click row                         │ click eye                                       │
        ▼                                   ▼                                                 │
     jumpTo(id)                       toggleReader(id) ── reader panel                        │
        │ loop: estimate scrollTop → page renders → bind() → found?                           │
        ▼                                                                                     │
     glideTo(el) → flash(el)            export / diagnostics / settings                       │
                    └─────────────────────────────────────────────────────────────────────────┘
```
Fallback when the data endpoint is unavailable: `mode = "dom"` — `items[]` is built from whatever rows are rendered
(`refreshDom`) and `loadFullHistory` scrolls to the top repeatedly to make claude.ai render older rows.

## 3. Files
| File | Role |
|---|---|
| `manifest.json` | MV3. Content script on `https://claude.ai/*` only. Permissions: `storage`, `activeTab`, `scripting`. Command `Alt+Shift+N`. |
| `content.js` | One IIFE, ~1100 lines, organised in banner-commented sections (below). No dependencies. |
| `sidebar.css` | Styling for sidebar, reader, toast, FAB, highlight. CSS variables `--cn-*`; dark mode via `html[data-mode="dark"]`, `html.dark`, or `prefers-color-scheme`. |
| `background.js` | Service worker. Receives the keyboard command, sends `{type:"TOGGLE_SIDEBAR"}` to the active claude.ai tab. |
| `popup/` | Toolbar popup: shortcut help and recent chats from `chrome.storage.local.cn_index`. |
| `tests/` | `fake-dom.js` (browser simulation), `harness.js` (loads the real `content.js`), `run.js` (suite). |

## 4. `content.js` sections
| Section (banner) | Contents |
|---|---|
| header + `CFG` | Constants: `ROW_H=56`, `BUFFER=8`, `SCAN_DEBOUNCE=250`, `STREAM_SCAN_THROTTLE=1200`, `LABEL_MAX=80`, `MAX_SAVED_CHATS=100`, selectors `CFG.SEL.user/asst`. |
| state | `items`, `mode`, `view`, `activeId`, `speed`, `pinned`, `sidebarVisible`, `readerId`, `jumpToken`, … (table in §5). |
| **UI** | `buildUI()` creates sidebar/FAB/toasts/reader and wires all listeners; `handleListClick()` is the single delegated row handler; `onGlobalKey()` shortcuts. |
| **DATA LAYER** | `fetchConversation` → `parseConversation` → `syncFromApi` (API source); `scanDOM`, `bind` (row↔item alignment); `refreshDom` (fallback); `scheduleScan/scheduleSync`; `makeLabel`; `updateSource`. |
| **FILTER + VIRTUALIZED RENDER** | `visibleList/applyFilter` (search + role filter), `renderWindow` (renders only visible rows), `scrollTocTo`, `setActive`, `stepActive`. |
| **JUMP** | `locateByText` (last-resort lookup), `findScroller`, `scrollToEl`, `glideTo`, `jumpTo/jumpToInner`, `flash`, `startSpy` (scroll-spy), fallback `loadFullHistory`. |
| **DIAGNOSTICS / READER** | `copyDiagnostics`; `toggleReader/openReader/closeReader/readerStep`. |
| **STORAGE / EXPORT** | `persist` (recent chats index), `exportMarkdown`, `saveJSON`, `saveSingle`. |
| **SIDEBAR OPEN/CLOSE, TOAST** | `openSidebar/closeSidebar`, `setPinned`, `toast`. |
| **NAVIGATION** | `loadChat`, `onNavigate`, `watchNavigation` (URL polling every 700 ms + `popstate`). |
| **UTIL + INIT** | `stepDelay/glideMs/setSpeed`, `sleep`, `esc`, `init()`. |

## 5. State
| Variable | Meaning |
|---|---|
| `items[]` | The conversation: `{id (uuid), role "human"/"assistant", text (raw markdown), label, sig, snip?, el (live DOM node or null)}`. **Object identity is stable across syncs.** |
| `mode` | `"api"` complete history · `"dom"` page-only fallback · `"none"` not loaded. |
| `view[]` | `items` after search + role filter; what the outline renders. |
| `activeId` | Row highlighted in the outline (kept in sync by scroll-spy and jumps). |
| `speed` | 1–10, default 5. `stepDelay()` = 330 − 30·(speed−1) ms; `glideMs()` = 0 at 10, ≈1400·((10−speed)/9)^1.2 ms otherwise. |
| `readerId` | Message shown in the reader, or `null` (reader closed). |
| `jumpToken` | Incremented by every jump and by user wheel/touch; a running jump stops when its token is stale. |
| `spyPausedUntil` | Timestamp until which scroll-spy ignores scrolling (our own programmatic scrolls). |
| `cachedOrg`, `convTitle`, `lastSync`, `lastDomCount`, `wasStreaming` | API/sync bookkeeping. |
| `lastJump` | `{id, n, steps, found, error?}` — included in Diagnostics. |

Persisted (`chrome.storage.local`): `cn_speed`, `cn_pinned`, `cn_sidebar_visible`, `cn_index` (recent chats).

## 6. Key flows

### 6.1 Loading a conversation
1. `init()` → `loadChat()` (also on every URL change via `onNavigate`).
2. `syncFromApi()` → `fetchConversation(chatId)`: org id from the `lastActiveOrg` cookie, else `/api/organizations`;
   tries each org until `GET /api/organizations/<org>/chat_conversations/<id>?tree=True&rendering_mode=messages&render_all_tools=true`
   returns `chat_messages`.
3. `parseConversation`: follow `current_leaf_message_uuid` back through `parent_message_uuid` (current branch only),
   join `type:"text"` blocks, skip empty (tool-only) turns, compute `label` and `sig`.
4. **Merge in place** (keep object identity; refresh `el` only if still connected), `mode="api"`, `bind()`, render.
5. Failure (HTTP error, no org matched, parse problem) → `mode="dom"` and the page-scraping fallback.
6. Later syncs are triggered when a new message appears on the page or streaming ends (`bind()` detects both),
   throttled to at most one per ~3 s.

### 6.2 `bind()` — matching rendered rows to data
Rendered rows are **consecutive messages**. Each row computes `sig` (first 40 letters/digits of its text, markdown
ignored). Every row votes for the offset `itemIndex − rowIndex` of each item whose `role+sig` matches; the winning offset
anchors the alignment. Then, row by row, the candidate closest to the expected position wins (within 8), with a
positional fallback when text differs (e.g. hidden UI text). This is what makes duplicates ("continue", or replies that
all start "Here's the updated code…") resolve correctly. *Plain text matching cannot do this.*

### 6.3 Jump (`jumpToInner`)
1. Close the reader; `setActive`; resolve the target **by id**.
2. If the target row is already bound → `glideTo` + `flash`.
3. Otherwise loop (≤80 steps, `stepDelay()` apart):
   - estimate the target scroll position: proportional to its index if nothing is bound, else
     `scrollTop ± max(0.6·viewport, distance·avgRowHeight·0.9)` toward the target using the bound range;
   - set `scrollTop` on the real scroller (`findScroller()`), wait for claude.ai to render, `bind()`;
   - target bound? → `glideTo` (ease in/out, duration from speed) → exact `scrollToEl` → `flash`.
   - If no rows are recognisable (selectors changed) the guess fans out around the estimate and `locateByText` is used.
4. Stop immediately if `jumpToken` changed (new jump or user wheel/touch). Give up after 80 steps or when the scroller
   stops moving; show a toast. **Never opens the reader.**

### 6.4 Outline rendering
Fixed row height (`ROW_H`). A spacer of `view.length × ROW_H` provides the scroll range; only rows in
`[scrollTop/ROW_H − BUFFER, (scrollTop+height)/ROW_H + BUFFER]` exist in the DOM. A render key
(window range, counts, filters, text lengths) lets `renderWindow` reuse existing rows when nothing changed, so a click
is never lost to a re-render. Row clicks use one delegated listener (`handleListClick`).

### 6.5 Scroll-spy
A capture-phase `scroll` listener on `document` picks the message nearest 30% of the viewport height and calls
`setActive`. It ignores scrolls originating inside the sidebar/reader, is paused during our own scrolling, and does not
auto-scroll the outline while the pointer is over the sidebar.

### 6.6 Reader (eye)
`handleListClick` → `toggleReader(id)`: closed or different id → `openReader(id)`; same id while open → `closeReader()`.
Closed by: second eye tap, close button, `Esc`, any jump, switching conversation. Opened by: **only** the eye (and its
prev/next buttons). The active eye gets `.cn-eye-on` and `aria-pressed`.

## 7. What we depend on in claude.ai (the fragile parts)
| Dependency | Used for | Where | If it breaks, you see | Fix |
|---|---|---|---|---|
| `GET /api/organizations` and `…/chat_conversations/<id>?tree=True&rendering_mode=messages…`, response fields `chat_messages[].{uuid,sender,content[],parent_message_uuid,index}`, `current_leaf_message_uuid`, `name` | The complete outline | `fetchConversation`, `parseConversation` | Badge **Page only**; Diagnostics `mode:"dom"` | Update URL/fields; the DOM fallback keeps basic function |
| `data-testid="user-message"` / `"assistant-message"` (+ `.font-user-message`, `.font-claude-message`, `.font-claude-response`) | Finding rendered messages | `CFG.SEL` | Diagnostics `domUserMsgs/domAsstMsgs: 0`, `boundToPage: 0`; jumps slower but still work via text | Update `CFG.SEL` |
| `data-testid="transcript-list"` (fallbacks `chat-column-body`, `chat-column`, `main`) | Scope for text lookup; finding the scroller | `transcriptRoot` | Text fallback less precise | Update the selector list |
| One ancestor with `overflow-y: auto/scroll` that is scrollable | Setting `scrollTop` | `findScroller`, `scrollParentOf` | Jumps do nothing; Diagnostics `scroller.h ≈ scroller.ch` | Adjust `findScroller` |
| `html[data-mode="dark"]` / `html.dark` | Theme | `sidebar.css` | Wrong theme only | Add the new selector |
| `data-is-streaming="true"` | Detecting a reply in progress | `bind`, `refreshDom` | Extra re-syncs only | Update selector |

## 8. Invariants (do not break — each was a real bug)
1. **Never keep an `items[]` object (or a `target`) across an `await` without re-resolving by id**, and keep object identity when syncing. (3.6: jump failed after a mid-jump re-sync.)
2. **Our own UI must not trigger our own listeners**: spy ignores sidebar/reader scrolls; MutationObserver ignores our nodes. (3.3: spy fought the user's clicks.)
3. **Never guess by loose text.** Alignment by position; the text fallback returns `null` when ambiguous. (3.6: jump landed on a look-alike reply.)
4. **Only the eye opens the reader.** No automatic fallbacks. (3.5.)
5. **Escape everything that reaches `innerHTML`** (`esc()`); message text is untrusted.
6. **Only same-origin `/api/` requests**; no remote code; no `localStorage`.
7. **Every referenced helper must exist** — the test suite type-checks for undefined names. (3.3: `setStatus is not defined`.)
8. The row height is fixed (`ROW_H`) — virtualization math depends on it.

## 9. Performance
- Outline: O(visible rows) DOM, O(n) filter on a string array. 5,000 messages filter + render in < 150 ms (tested).
- Scans are throttled (250 ms) and idle-scheduled; during streaming only the last row is re-read.
- `bind()` touches only rendered rows (≈3–10), using cached signatures (`WeakMap`).
- API sync ≤ one per ~3 s, merges in place.

## 10. Security and privacy
Content script only on `https://claude.ai/*`. Network: same-origin `/api/organizations…` GETs with the user's own
session. No external hosts. Message text lives in memory only; `chrome.storage.local` holds settings and a recent-chats
index (title, URL, message count, timestamp). Diagnostics exclude message text and redact the chat id.
Popup opens only `https://claude.ai/` URLs.

## 11. Extending
- **New setting:** add markup in the settings panel (`buildUI`), a state variable + `safeSet({cn_x})`, load it in `init()`'s `storage.get`, add a test in suite 8.
- **New filter/column in the outline:** extend `visibleList()`, keep `ROW_H` fixed, include new state in the render key in `renderWindow`.
- **Selector change by claude.ai:** edit `CFG.SEL`; run `node tests/run.js`; use the `selectorless` harness option to prove the fallback still works.
