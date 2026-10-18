# Changelog

## 3.6.0
- **Fix:** jumping could fail when the conversation re-synced mid-jump (the jump held a stale copy of its target).
  Messages now keep their identity across syncs and the jump re-resolves its target each step.
- **Fix:** far jumps could land on the wrong message when several replies start with the same words
  ("Here's the updated code…"). Rendered rows are now aligned to the data by position, and the text fallback refuses
  to guess between look-alikes.
- **Fix:** keyboard shortcut changed from `Ctrl+Shift+N` (reserved by Chrome, never worked) to `Alt+Shift+N`.
- **Eye icon is a toggle:** tap to show the message, tap again to hide; the active eye stays highlighted.
- Popup redesigned to match the sidebar; version label is read from the manifest; recent-chat links restricted to claude.ai.
- If claude.ai changes its markup, jumping still works via a text-based fallback with outward scanning.
- Added automated test suite, architecture/troubleshooting/testing docs.

## 3.5.0
- Scroll speed setting (1–10, default 5) with smooth glide; scrolling cancels a jump.
- Complete visual redesign (light/dark, single accent, settings panel).
- The reader no longer opens automatically; only the eye icon opens it.

## 3.4.0
- Jump rewritten for claude.ai's virtualized transcript: estimate → render → correct loop.
- Fixed `setStatus is not defined` crash introduced in 3.3.

## 3.3.0
- Fixed scroll-spy feedback loop that undid clicks; outline no longer re-renders rows needlessly.
- Added Diagnostics report; jump errors are shown instead of failing silently.

## 3.2.0
- Jump finds messages by text instead of CSS selectors.

## 3.1.0
- Conversation loaded from claude.ai's data (complete history) instead of scraping the page; reader panel; Reload.

## 3.0.0
- Virtualized outline, debounced scanning, search, export, pin.

## 2.0.0
- Original version (page scraping, localStorage-style saves).
