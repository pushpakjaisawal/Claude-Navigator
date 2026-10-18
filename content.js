/*
  content.js — Claude Navigator
  Outline + jump for very long claude.ai conversations.   (Read docs/ARCHITECTURE.md first.)

  Data flow:   claude.ai conversation API ──► items[] (complete history)
               rendered page rows         ──► bind() attaches live elements to items
               click row ─► jumpTo(): scroll → let claude.ai render → bind() → glide → highlight

  Rules that keep this working (each one was a real bug — see docs/TROUBLESHOOTING.md):
   1. Never hold a stale reference to an item across an await; re-resolve by id.
   2. Our own scrolling/DOM must never feed back into scroll-spy or the mutation observer.
   3. Never guess a message by loose text; ambiguous → do nothing rather than land on the wrong one.
   4. The reader opens ONLY from the eye button.
   5. Every piece of message text that reaches innerHTML goes through esc().
*/
(function () {
  "use strict";
  if (window.__claudeNavLoaded) return;
  window.__claudeNavLoaded = true;

  // ── Config ────────────────────────────────────────────────────────────────
  const CFG = {
    ROW_H: 56,               // fixed TOC row height (required for virtualization)
    BUFFER: 8,               // extra rows rendered above/below viewport
    SCAN_DEBOUNCE: 250,
    STREAM_SCAN_THROTTLE: 1200, // while Claude is typing, rescan text rarely
    LABEL_MAX: 80,
    MAX_SAVED_CHATS: 100,
    SEL: {
      user: '[data-testid="user-message"], .font-user-message',
      asst: '[data-testid="assistant-message"], .font-claude-message, .font-claude-response, [data-is-streaming]',
    },
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let items = [];                 // [{id, role, label, text, sig, el}]
  let mode = "none";              // "api" (full history) | "dom" (page scan fallback)
  let cachedOrg = null;
  let lastDomCount = 0, lastSync = 0, syncTimer = null, wasStreaming = false;
  const sigCache = new WeakMap();
  let filtered = null;            // null or array of indexes into items
  let query = "";
  let roleFilter = "all";         // all | human | assistant
  let sidebarVisible = true;
  let pinned = false;
  let activeId = null;
  let observer = null;
  let scanTimer = null;
  let lastFullScan = 0;
  let scroller = null;
  let spyRaf = 0;
  let renderRaf = 0;
  let currentChatId = chatIdFromUrl();
  const idMap = new WeakMap();    // element -> id
  let idCounter = 0;
  let jumpToken = 0;
  let spyPausedUntil = 0, sidebarHovered = false, lastJump = null;
  let speed = 5;                  // 1 (slowest) … 10 (fastest)

  const $ = (id) => document.getElementById(id);
  const isChatPage = () => /^\/chat\//.test(location.pathname);
  function chatIdFromUrl() {
    const m = location.pathname.match(/\/chat\/([\w-]+)/);
    return m ? m[1] : null;
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  UI
  // ═════════════════════════════════════════════════════════════════════════
  const ICON = {
    bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    up: '<polyline points="18 15 12 9 6 15"/>',
    down: '<polyline points="6 9 12 15 18 9"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    ai: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  };
  const svg = (p, s = 14, w = 2) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

  function buildUI() {
    const overlay = document.createElement("div");
    overlay.id = "claude-nav-overlay";
    document.addEventListener("pointerdown", (e) => {
      if (!sidebarVisible || pinned) return;
      if (e.target.closest && e.target.closest("#claude-nav-sidebar, #claude-nav-fab, #cn-reader")) return;
      closeSidebar();
    }, true);

    const sb = document.createElement("aside");
    sb.id = "claude-nav-sidebar";
    sb.setAttribute("role", "complementary");
    sb.setAttribute("aria-label", "Claude Navigator");
    sb.innerHTML = `
      <div id="cn-header">
        <div id="cn-title">
          <span id="cn-icon-wrap">${svg('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="18" y2="18"/>', 16, 2.2)}</span>
          <span id="cn-title-text">Navigator</span>
        </div>
        <div id="cn-controls">
          <button id="cn-pin-btn" title="Keep open while using the chat" aria-label="Pin sidebar" aria-pressed="false">${svg('<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>', 15)}</button>
          <button id="cn-settings-btn" title="Settings" aria-label="Settings" aria-expanded="false">${svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', 15)}</button>
          <button id="cn-toggle-btn" title="Close (Esc)" aria-label="Close sidebar">${svg(ICON.x, 15)}</button>
        </div>
      </div>

      <div id="cn-settings" hidden>
        <div class="cn-set-block">
          <div class="cn-set-head"><label for="cn-speed">Scroll speed</label><span id="cn-speed-val">5</span></div>
          <input id="cn-speed" type="range" min="1" max="10" step="1" value="5" aria-label="Scroll speed"/>
          <div class="cn-set-scale"><span>Slower</span><span>Faster</span></div>
        </div>
        <div class="cn-set-block">
          <div class="cn-set-title">Export</div>
          <div class="cn-set-actions">
            <button class="cn-btn" id="cn-export-btn">Markdown</button>
            <button class="cn-btn" id="cn-save-all-btn">JSON</button>
          </div>
        </div>
        <div class="cn-set-block">
          <div class="cn-set-title">Conversation</div>
          <div class="cn-set-actions">
            <button class="cn-btn" id="cn-load-btn">Reload</button>
            <button class="cn-btn" id="cn-diag-btn" title="Copies a report with no message text">Diagnostics</button>
          </div>
        </div>
        <div class="cn-set-foot"><kbd>/</kbd> search &nbsp; <kbd>↑</kbd><kbd>↓</kbd> move &nbsp; <kbd>Enter</kbd> go &nbsp; <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> toggle</div>
      </div>

      <div id="cn-search-wrap">
        ${svg(ICON.search, 14).replace("<svg", '<svg id="cn-search-icon"')}
        <input id="cn-search" type="text" placeholder="Search this conversation" autocomplete="off" spellcheck="false" aria-label="Search messages"/>
      </div>
      <div id="cn-filters">
        <div id="cn-seg" role="tablist">
          <button class="cn-chip cn-chip-on" data-f="all">All</button>
          <button class="cn-chip" data-f="human">You</button>
          <button class="cn-chip" data-f="assistant">Claude</button>
        </div>
        <span id="cn-spacer"></span>
        <button class="cn-icon-btn" id="cn-top" title="First message" aria-label="First message">${svg('<line x1="6" y1="4" x2="18" y2="4"/><polyline points="18 14 12 8 6 14"/>', 14)}</button>
        <button class="cn-icon-btn" id="cn-bottom" title="Latest message" aria-label="Latest message">${svg('<line x1="6" y1="20" x2="18" y2="20"/><polyline points="6 10 12 16 18 10"/>', 14)}</button>
      </div>
      <div id="cn-stats"><span id="cn-count">0 messages</span><span id="cn-source"></span></div>
      <div id="cn-toc-list" role="list" tabindex="0">
        <div id="cn-toc-spacer"><div id="cn-toc-window"></div></div>
        <div id="cn-empty" hidden></div>
      </div>`;

    const fab = document.createElement("button");
    fab.id = "claude-nav-fab";
    fab.title = "Open Claude Navigator (Alt+Shift+N)";
    fab.setAttribute("aria-label", "Open Claude Navigator");
    fab.innerHTML = svg('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="18" y2="18"/>', 20, 2.2);

    const toasts = document.createElement("div");
    toasts.id = "cn-toast-container";
    toasts.setAttribute("aria-live", "polite");

    const reader = document.createElement("div");
    reader.id = "cn-reader"; reader.hidden = true;
    reader.setAttribute("role", "dialog"); reader.setAttribute("aria-label", "Message reader");
    reader.innerHTML = `<div id="cn-reader-head"><span id="cn-reader-title"></span>
      <span class="cn-reader-actions"><button id="cn-reader-prev" aria-label="Previous message" title="Previous">${svg(ICON.up)}</button><button id="cn-reader-next" aria-label="Next message" title="Next">${svg(ICON.down)}</button>
      <button id="cn-reader-copy">Copy</button><button id="cn-reader-go">Show in chat</button><button id="cn-reader-close" aria-label="Close reader" title="Close">${svg(ICON.x)}</button></span></div>
      <pre id="cn-reader-body"></pre>`;
    document.body.append(overlay, sb, fab, toasts, reader);
    $("cn-reader-close").addEventListener("click", closeReader);
    $("cn-reader-copy").addEventListener("click", () => {
      const m = items.find((x) => x.id === readerId);
      if (m) navigator.clipboard.writeText(m.text).then(() => toast("Copied"), () => toast("Copy failed"));
    });
    $("cn-reader-go").addEventListener("click", () => { const id = readerId; closeReader(); jumpTo(id); });
    $("cn-reader-prev").addEventListener("click", () => readerStep(-1));
    $("cn-reader-next").addEventListener("click", () => readerStep(1));

    $("cn-toggle-btn").addEventListener("click", closeSidebar);
    $("cn-pin-btn").addEventListener("click", () => setPinned(!pinned));
    fab.addEventListener("click", openSidebar);
    $("cn-export-btn").addEventListener("click", exportMarkdown);
    $("cn-diag-btn").addEventListener("click", copyDiagnostics);
    $("cn-settings-btn").addEventListener("click", () => setSettingsOpen($("cn-settings").hidden));
    $("cn-speed").addEventListener("input", (e) => setSpeed(e.target.value, true));
    document.addEventListener("pointerdown", (e) => {
      const p = $("cn-settings");
      if (p && !p.hidden && !(e.target.closest && e.target.closest("#cn-settings, #cn-settings-btn"))) setSettingsOpen(false);
    }, true);
    $("cn-save-all-btn").addEventListener("click", saveJSON);
    $("cn-load-btn").addEventListener("click", async () => {
      const b = $("cn-load-btn"); b.classList.add("cn-chip-on");
      const ok = await syncFromApi();
      if (!ok && mode !== "api") { mode = "dom"; updateSource(); loadFullHistory(false); }
      else toast(`${items.length} messages loaded`);
      b.classList.remove("cn-chip-on");
    });
    $("cn-top").addEventListener("click", () => items.length && jumpTo(items[0].id));
    $("cn-bottom").addEventListener("click", () => items.length && jumpTo(items[items.length - 1].id));

    const input = $("cn-search");
    let st;
    input.addEventListener("input", () => {
      clearTimeout(st);
      st = setTimeout(() => { query = input.value.trim().toLowerCase(); applyFilter(); }, 120);
    });
    sb.querySelectorAll(".cn-chip[data-f]").forEach((b) =>
      b.addEventListener("click", () => {
        roleFilter = b.dataset.f;
        sb.querySelectorAll(".cn-chip[data-f]").forEach((x) => x.classList.toggle("cn-chip-on", x === b));
        applyFilter();
      })
    );

    const list = $("cn-toc-list");
    list.addEventListener("scroll", scheduleRender, { passive: true });
    // Event delegation: one listener for all rows (no per-row listeners)
    list.addEventListener("click", handleListClick);
    list.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        stepActive(e.key === "ArrowDown" ? 1 : -1, true);
      } else if (e.key === "Enter" && activeId) jumpTo(activeId);
    });

    sb.addEventListener("mouseenter", () => { sidebarHovered = true; });
    sb.addEventListener("mouseleave", () => { sidebarHovered = false; });
    document.addEventListener("keydown", onGlobalKey, true);
    window.addEventListener("resize", scheduleRender, { passive: true });
  }

  function onGlobalKey(e) {
    const a = document.activeElement;
    const typing = a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.isContentEditable);
    if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (!sidebarVisible) openSidebar();
      $("cn-search")?.focus();
    } else if (e.key === "Escape" && $("cn-settings") && !$("cn-settings").hidden) {
      setSettingsOpen(false);
    } else if (e.key === "Escape" && $("cn-reader") && !$("cn-reader").hidden) {
      closeReader();
    } else if (e.key === "Escape") {
      const s = $("cn-search");
      if (a === s) {
        if (s.value) { s.value = ""; query = ""; applyFilter(); } else s.blur();
      } else if (sidebarVisible && !typing) closeSidebar();
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      stepActive(e.key === "ArrowDown" ? 1 : -1, true);
    } else if (a === $("cn-search") && (e.key === "ArrowDown" || e.key === "Enter")) {
      e.preventDefault();
      const v = visibleList();
      if (v.length) { activeId = activeId && v.some((m) => m.id === activeId) ? activeId : v[0].id; if (e.key === "Enter") jumpTo(activeId); else { scrollTocTo(activeId); scheduleRender(); } }
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  DATA LAYER: API source → items[], DOM binding, DOM fallback
  // ═════════════════════════════════════════════════════════════════════════
  function getId(el) {
    let id = idMap.get(el);
    if (!id) { id = "cn" + ++idCounter; idMap.set(el, id); }
    return id;
  }

  function scanDOM() {
    const out = [];
    const nodes = document.querySelectorAll(`${CFG.SEL.user}, ${CFG.SEL.asst}`);
    let prev = null;
    nodes.forEach((el) => {
      if (el.closest("#claude-nav-sidebar, #cn-reader")) return;
      if (prev && prev.contains(el)) return;     // nested duplicate
      prev = el;
      out.push({ id: getId(el), role: el.matches(CFG.SEL.user) ? "human" : "assistant", el });
    });
    return out;
  }

  // Normalised signature of the first characters of a text (markdown-insensitive)
  const mkSig = (t) => (t || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, 40);

  function domSig(el, force) {
    if (!force && sigCache.has(el)) return sigCache.get(el);
    const s = mkSig((el.textContent || "").slice(0, 600));
    sigCache.set(el, s);
    return s;
  }

  // ── Source 1: claude.ai's own conversation data (complete, independent of rendering) ──
  async function getOrgIds() {
    const ids = [];
    const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    if (m) ids.push(decodeURIComponent(m[1]));
    try {
      const r = await fetch("/api/organizations", { credentials: "same-origin", headers: { accept: "application/json" } });
      if (r.ok) (await r.json() || []).forEach((o) => o && o.uuid && !ids.includes(o.uuid) && ids.push(o.uuid));
    } catch (_) {}
    return ids;
  }

  function msgText(m) {
    let t = "";
    if (Array.isArray(m.content) && m.content.length)
      t = m.content.filter((b) => b && b.type === "text" && b.text).map((b) => b.text).join("\n\n");
    if (!t.trim() && typeof m.text === "string") t = m.text;
    return t.trim();
  }

  function parseConversation(j) {
    const msgs = j.chat_messages;
    const byId = new Map(msgs.map((m) => [m.uuid, m]));
    let chain = [];
    if (j.current_leaf_message_uuid && byId.has(j.current_leaf_message_uuid)) {
      const seen = new Set();
      let cur = byId.get(j.current_leaf_message_uuid);
      while (cur && !seen.has(cur.uuid)) { seen.add(cur.uuid); chain.push(cur); cur = byId.get(cur.parent_message_uuid); }
      chain.reverse();                           // follow the CURRENT branch only
    } else {
      chain = [...msgs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    }
    const out = [];
    for (const m of chain) {
      const text = msgText(m);
      if (!text) continue;                       // tool-only turns
      out.push({ id: m.uuid, role: m.sender === "human" ? "human" : "assistant", text, label: makeLabel(text), sig: mkSig(text), el: null, ts: m.created_at });
    }
    return { title: j.name || "", list: out };
  }

  async function fetchConversation(cid) {
    const tryOrg = async (org) => {
      const r = await fetch(`/api/organizations/${org}/chat_conversations/${cid}?tree=True&rendering_mode=messages&render_all_tools=true`,
        { credentials: "same-origin", headers: { accept: "application/json" } });
      if (!r.ok) return null;
      const j = await r.json();
      return j && Array.isArray(j.chat_messages) ? j : null;
    };
    try {
      if (cachedOrg) { const j = await tryOrg(cachedOrg); if (j) return j; }
      for (const org of await getOrgIds()) {
        try { const j = await tryOrg(org); if (j) { cachedOrg = org; return j; } } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  let apiBusy = false, convTitle = "";
  async function syncFromApi() {
    const cid = chatIdFromUrl();
    if (!cid || apiBusy) return false;
    apiBusy = true; lastSync = Date.now();
    try {
      const j = await fetchConversation(cid);
      if (cid !== currentChatId) return false;   // user navigated away meanwhile
      if (!j) return false;
      const { title, list } = parseConversation(j);
      if (!list.length) return false;
      // Keep each message OBJECT stable across syncs (jumps/readers hold references to them); update fields in place.
      const old = new Map(items.map((m) => [m.id, m]));
      const merged = list.map((m) => {
        const o = old.get(m.id);
        if (!o) return m;
        const el = o.el && o.el.isConnected ? o.el : null;
        Object.assign(o, m, { el }); o.snip = undefined;
        return o;
      });
      items = merged; mode = "api"; convTitle = title;
      bind();
      applyFilter(); persist(); updateSource();
      return true;
    } finally { apiBusy = false; }
  }

  // Attach rendered DOM nodes to data items (so we can scroll to them)
  function bind() {
    if (mode !== "api") return;
    const nodes = scanDOM();
    items.forEach((m) => { if (m.el && !m.el.isConnected) m.el = null; });
    const bySig = new Map();
    items.forEach((m, i) => { const k = m.role + m.sig; (bySig.get(k) || bySig.set(k, []).get(k)).push(i); });
    const sigs = nodes.map((n, i) => domSig(n.el, i === nodes.length - 1 && wasStreaming));

    // Align the rendered rows to the data. Rendered rows are CONSECUTIVE messages, so every row votes for the
    // offset (item index − row index) of each item it matches; the winning offset anchors duplicates such as
    // "continue" or boilerplate openings ("Here's the updated code…"), which a plain text match can't tell apart.
    const votes = new Map();
    nodes.forEach((n, j) => { if (sigs[j]) (bySig.get(n.role + sigs[j]) || []).forEach((i) => votes.set(i - j, (votes.get(i - j) || 0) + 1)); });
    let off = null, bestVotes = 0;
    votes.forEach((v, d) => { if (v > bestVotes || (v === bestVotes && d > off)) { bestVotes = v; off = d; } });   // tie → newest
    const used = new Set();
    let prev = -1;
    nodes.forEach((n, j) => {
      const expected = prev >= 0 ? prev + 1 : (off !== null ? j + off : -1);
      let hit = -1;
      const cands = sigs[j] ? bySig.get(n.role + sigs[j]) : null;
      if (cands && cands.length) {
        let bestD = Infinity;
        for (const c of cands) {
          if (c <= prev || used.has(c)) continue;
          const d = expected >= 0 ? Math.abs(c - expected) : c;
          if (d < bestD) { bestD = d; hit = c; }
        }
        if (expected >= 0 && bestD > 8) hit = -1;                    // too far from where this row should be
      }
      if (hit < 0 && expected > prev && items[expected] && items[expected].role === n.role && !used.has(expected)) hit = expected; // positional fallback
      if (hit >= 0) { items[hit].el = n.el; used.add(hit); prev = hit; }
    });
    // new message appeared on the page that the data doesn't know yet → resync
    const streaming = !!document.querySelector('[data-is-streaming="true"]');
    if ((nodes.length > lastDomCount && lastDomCount > 0) || (wasStreaming && !streaming)) scheduleSync(streaming ? 4000 : 1200);
    lastDomCount = nodes.length; wasStreaming = streaming;
  }

  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    const wait = Math.max(delay, 3000 - (Date.now() - lastSync));
    syncTimer = setTimeout(syncFromApi, Math.max(wait, 0));
  }

  // ── Source 2 (fallback): read what the page currently renders ─────────────
  function refreshDom(force) {
    const found = scanDOM();
    if (!found.length && items.length && !force) return;
    const oldById = new Map(items.map((m) => [m.id, m]));
    const streaming = !!document.querySelector('[data-is-streaming="true"]');
    const now = Date.now();
    const next = found.map((f, i) => {
      const old = oldById.get(f.id), last = i === found.length - 1;
      let reread = !old || force || (last && streaming && now - lastFullScan > CFG.STREAM_SCAN_THROTTLE) || (last && !streaming && old && old.streaming);
      if (!reread) { old.el = f.el; return old; }
      const text = (f.el.innerText || f.el.textContent || "").trim();
      return { id: f.id, role: f.role, text, label: makeLabel(text), sig: mkSig(text), el: f.el, streaming: last && streaming };
    });
    if (streaming) lastFullScan = now;
    const changed = next.length !== items.length || next.some((m, i) => m !== items[i]);
    items = next;
    if (changed) { applyFilter(); persist(); }
  }

  function refresh(force) {
    if (mode === "api") bind(); else refreshDom(force);
  }

  function scheduleScan(force) {
    if (scanTimer) return;                       // throttle (not debounce): runs steadily during streaming
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const run = () => refresh(force);
      "requestIdleCallback" in window ? requestIdleCallback(run, { timeout: 800 }) : run();
    }, CFG.SCAN_DEBOUNCE);
  }

  function makeLabel(text) {
    for (const line of text.split("\n")) {
      const c = line.trim().replace(/^#+\s*/, "").replace(/^[*\->•]+\s*/, "").replace(/[`*_]/g, "");
      if (c.length > 2) return c.length > CFG.LABEL_MAX ? c.slice(0, CFG.LABEL_MAX) + "…" : c;
    }
    return text.slice(0, CFG.LABEL_MAX) || "Message";
  }

  function updateSource() {
    const el = $("cn-source");
    if (!el) return;
    el.textContent = mode === "api" ? "Full history" : mode === "dom" ? "Page only" : "";
    el.title = mode === "api" ? "Complete conversation loaded from claude.ai" : "Only messages rendered on the page are listed (full history unavailable)";
    el.classList.toggle("cn-src-warn", mode === "dom");
  }

  function startObserver() {
    observer?.disconnect();
    observer = new MutationObserver((muts) => {
      // Ignore mutations caused by our own UI
      for (const m of muts) {
        const t = m.target;
        const host = t.nodeType === 1 ? t : t.parentElement;
        if (host && host.closest && host.closest("#claude-nav-sidebar, #cn-toast-container, #claude-nav-fab, #claude-nav-overlay, #cn-reader")) continue;
        scheduleScan(false);
        return;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  FILTER + VIRTUALIZED RENDER
  // ═════════════════════════════════════════════════════════════════════════
  function visibleList() {
    if (!query && roleFilter === "all") return items;
    return items.filter(
      (m) => (roleFilter === "all" || m.role === roleFilter) && (!query || m.text.toLowerCase().includes(query))
    );
  }

  let view = [];
  function applyFilter() {
    lastRenderKey = "";
    view = visibleList();
    updateStats();
    const empty = $("cn-empty");
    if (empty) {
      empty.hidden = view.length > 0;
      empty.textContent = items.length === 0
        ? (isChatPage() ? "Waiting for messages…" : "Open a conversation to see its outline.")
        : "No messages match.";
    }
    const sp = $("cn-toc-spacer");
    if (sp) sp.style.height = view.length * CFG.ROW_H + "px";
    scheduleRender();
  }

  function updateStats() {
    const h = items.filter((m) => m.role === "human").length;
    const el = $("cn-count");
    if (!el) return;
    el.textContent = query || roleFilter !== "all"
      ? `${view.length} of ${items.length} shown`
      : `${h} prompts · ${items.length - h} responses`;
  }

  function scheduleRender() {
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(() => { renderRaf = 0; renderWindow(); });
  }

  let lastRenderKey = "";
  function renderWindow() {
    const list = $("cn-toc-list"), win = $("cn-toc-window");
    if (!list || !win) return;
    const top = list.scrollTop, h = list.clientHeight || 400;
    const start = Math.max(0, Math.floor(top / CFG.ROW_H) - CFG.BUFFER);
    const end = Math.min(view.length, Math.ceil((top + h) / CFG.ROW_H) + CFG.BUFFER);
    win.style.transform = `translateY(${start * CFG.ROW_H}px)`;

    const key = `${start}|${end}|${view.length}|${items.length}|${query}|${roleFilter}|${view[start]?.id}|${view[end - 1]?.id}|${view[start]?.text.length}|${view[end - 1]?.text.length}`;
    if (key === lastRenderKey) {                                  // same rows: only update the active highlight in place
      win.querySelectorAll(".cn-toc-item").forEach((r) => r.classList.toggle("cn-active", r.dataset.id === activeId));
      return;
    }
    lastRenderKey = key;

    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const m = view[i];
      const row = document.createElement("div");
      const reading = m.id === readerId;
      row.className = `cn-toc-item cn-${m.role}${m.id === activeId ? " cn-active" : ""}${reading ? " cn-reading" : ""}`;
      row.dataset.id = m.id;
      row.setAttribute("role", "listitem");
      row.style.height = CFG.ROW_H + "px";
      row.title = m.text.slice(0, 200);
      const n = items.indexOf(m) + 1; // O(n) but only for ~30 rows
      row.innerHTML = `
        <div class="cn-toc-left">
          <span class="cn-toc-avatar ${m.role === "human" ? "cn-human-icon" : "cn-ai-icon"}" aria-hidden="true">${m.role === "human" ? "Y" : "C"}</span>
          <div class="cn-toc-body">
            <span class="cn-toc-role">${m.role === "human" ? "You" : "Claude"} · #${n}</span>
            <span class="cn-toc-label">${highlight(m.label)}</span>
          </div>
        </div>
        <span class="cn-row-btns">
          <button class="cn-read-btn${reading ? " cn-eye-on" : ""}" title="${reading ? "Hide message" : "Show message"}" aria-label="${reading ? "Hide" : "Show"} message ${n}" aria-pressed="${reading}">${svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>', 12, 2.5)}</button>
          <button class="cn-save-single-btn" title="Save this message" aria-label="Save message ${n}">${svg(ICON.save, 12, 2.5)}</button>
        </span>`;
      frag.appendChild(row);
    }
    win.replaceChildren(frag);
  }

  function highlight(label) {
    const safe = esc(label);
    if (!query) return safe;
    const q = esc(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try { return safe.replace(new RegExp(q, "ig"), (s) => `<mark class="cn-mark">${s}</mark>`); } catch { return safe; }
  }

  function scrollTocTo(id) {
    const i = view.findIndex((m) => m.id === id);
    const list = $("cn-toc-list");
    if (i < 0 || !list) return;
    const y = i * CFG.ROW_H;
    if (y < list.scrollTop) list.scrollTop = y;
    else if (y + CFG.ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = y + CFG.ROW_H - list.clientHeight;
  }

  function setActive(id, reveal) {
    if (activeId === id) return;
    activeId = id;
    if (reveal && sidebarVisible) scrollTocTo(id);
    scheduleRender();
  }

  function stepActive(dir, doJump) {
    if (!view.length) return;
    let i = view.findIndex((m) => m.id === activeId);
    i = i < 0 ? (dir > 0 ? 0 : view.length - 1) : Math.min(view.length - 1, Math.max(0, i + dir));
    const id = view[i].id;
    setActive(id, true);
    if (doJump) jumpTo(id);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  JUMP (works even when the message is not currently rendered)
  // ═════════════════════════════════════════════════════════════════════════
  // ── Selector-independent lookup: find a message on the page by its text ──────────────
  const norm = (t) => (t || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  // First 40 alphanumeric characters of the WHOLE message (markdown symbols vanish in norm()).
  function snippetOf(m) {
    if (m.snip === undefined) m.snip = norm(m.text).slice(0, 40);
    return m.snip;
  }

  function elementBlock(start) {
    let el = start;
    const msg = el && el.closest('[data-testid="user-message"], [data-testid="assistant-message"], .font-user-message, .font-claude-message, .font-claude-response');
    if (msg) return msg;
    while (el && el.parentElement && el !== document.body) {          // nearest sizeable block-level element
      const d = getComputedStyle(el).display;
      if ((d === "block" || d === "flex" || d === "list-item") && el.getBoundingClientRect().height > 20) return el;
      el = el.parentElement;
    }
    return start;
  }

  function transcriptRoot() {
    return document.querySelector('[data-testid="transcript-list"], [data-testid="chat-column-body"], [data-testid="chat-column"]') || document.querySelector("main") || document.body;
  }

  // LAST-RESORT lookup, used only when claude.ai's message selectors stop matching anything.
  // It never guesses: if several messages share the same opening and we can't tell them apart, it returns null.
  function locateByText(target) {
    const root = transcriptRoot();
    const full = snippetOf(target);
    if (full.length < 6) return null;
    const MSG = '[data-testid="user-message"], [data-testid="assistant-message"], .font-user-message, .font-claude-message, .font-claude-response';
    const inUi = "#claude-nav-sidebar, #cn-reader, #cn-toast-container, #claude-nav-fab";

    // Find text nodes that begin the message, then climb to the smallest ancestor that contains the WHOLE opening
    // (works whether the message is one paragraph or several blocks split by **bold**, `code`, headings…).
    const gather = (needle) => {
      const set = new Set();
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => n.parentElement && !n.parentElement.closest(inUi + ", script, style, textarea") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      while (w.nextNode()) {
        const n = norm(w.currentNode.nodeValue);
        if (n.length < 3 || !(n.includes(needle) || needle.startsWith(n))) continue;
        let el = w.currentNode.parentElement;
        while (el && el !== root && !norm((el.textContent || "").slice(0, 600)).includes(needle)) el = el.parentElement;
        if (el && el !== root) set.add(elementBlock(el));
      }
      const arr = [...set].sort((x, y) => (x.compareDocumentPosition(y) & 4 ? -1 : 1));
      return arr.filter((b, i) => !arr.some((o, j) => j < i && o.contains && o.contains(b)));   // drop nested duplicates
    };

    for (const needle of [full, full.slice(0, 24)]) {
      if (needle.length < 12) break;
      const blocks = gather(needle);
      if (!blocks.length) continue;
      const same = items.filter((m) => m.role === target.role && snippetOf(m).startsWith(needle));
      if (same.length <= 1) return blocks[0];                                      // unique opening: first hit (later ones are quotes)
      if (blocks.length === same.length) return blocks[same.indexOf(target)] || null; // every duplicate is rendered → exact ordinal
      return null;                                                                 // ambiguous: refuse to guess
    }
    return null;
  }

  let scrollerCache = null;
  function findScroller() {
    if (scrollerCache && scrollerCache.isConnected && scrollerCache.scrollHeight > scrollerCache.clientHeight + 4) return scrollerCache;
    let probe = items.find((m) => m.el && m.el.isConnected)?.el || document.querySelector(`${CFG.SEL.user}, ${CFG.SEL.asst}`);
    let p = probe ? probe.parentElement : null;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 4) return (scrollerCache = p);
      p = p.parentElement;
    }
    for (let q = transcriptRoot(); q && q !== document.body; q = q.parentElement) {   // walk up from the transcript itself
      if (/(auto|scroll)/.test(getComputedStyle(q).overflowY) && q.scrollHeight > q.clientHeight + 4) return (scrollerCache = q);
    }
    // generic: the tallest scrollable element that isn't ours
    let best = null, bestH = 0;
    document.querySelectorAll("main, main *, body > div, body > div > div, body > div > div > div").forEach((el) => {
      if (el.closest("#claude-nav-sidebar, #cn-reader")) return;
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.clientHeight > 250 && el.scrollHeight > el.clientHeight + 4 && el.scrollHeight > bestH) { best = el; bestH = el.scrollHeight; }
    });
    return (scrollerCache = best || document.scrollingElement || document.documentElement);
  }

  // Scroll el to the top of the chat, trying scrollIntoView first, then every scrollable ancestor + window.
  function scrollToEl(el) {
    el.style.scrollMarginTop = "90px";
    try { el.scrollIntoView({ behavior: "auto", block: "start" }); } catch (_) {}
    const off = () => el.getBoundingClientRect().top;
    if (Math.abs(off() - 90) < 40) return;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) {
        p.scrollTop += off() - 90;
        if (Math.abs(off() - 90) < 40) return;
      }
    }
    window.scrollBy(0, off() - 90);
  }

  function scrollParentOf(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
    }
    return null;
  }

  // Smoothly glide the chat so `el` sits near the top; speed setting controls the duration.
  async function glideTo(el, token) {
    const sc = scrollParentOf(el), dur = glideMs();
    if (!sc || dur === 0) { scrollToEl(el); return; }
    const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 90;
    if (Math.abs(delta) < 4) return;
    const start = sc.scrollTop, t0 = performance.now();
    spyPausedUntil = Date.now() + dur + 400;
    await new Promise((resolve) => {
      const tick = (now) => {
        if (token !== jumpToken || !el.isConnected) return resolve();
        const p = Math.min(1, (now - t0) / dur);
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;   // ease-in-out
        sc.scrollTop = start + delta * e;
        p < 1 ? requestAnimationFrame(tick) : resolve();
      };
      requestAnimationFrame(tick);
    });
    if (token === jumpToken && el.isConnected) scrollToEl(el);                // precise final alignment
  }

  async function jumpTo(id) {
    // any manual scroll/touch in the chat cancels an in-flight jump (the user is in control)
    const onUser = (e) => { if (!(e.target && e.target.closest && e.target.closest("#claude-nav-sidebar, #cn-reader"))) jumpToken++; };
    ["wheel", "touchstart"].forEach((ev) => window.addEventListener(ev, onUser, { passive: true, capture: true }));
    try { await jumpToInner(id); }
    catch (err) {
      console.error("[Claude Navigator] jump failed", err);
      lastJump = { id, error: String(err && err.stack || err) };
      toast("Couldn't jump to that message");
    } finally {
      ["wheel", "touchstart"].forEach((ev) => window.removeEventListener(ev, onUser, true));
      setStatus(null);
    }
  }

  async function jumpToInner(id) {
    const token = ++jumpToken;
    spyPausedUntil = Date.now() + 1500;
    closeReader();                                   // the reader only ever opens from the eye button
    const live = () => items.find((m) => m.id === id);
    let target = live();
    if (!target) { toast("Message not found — try Reload in settings"); return; }
    setActive(id, true);
    lastJump = { id, n: items.indexOf(target) + 1, at: new Date().toISOString(), steps: 0, found: false };

    const find = () => {
      target = live() || target;                                  // a re-sync may have replaced the list: never hold a stale copy
      if (target.el && target.el.isConnected) return target.el;
      if (mode === "api" && scanDOM().length) return null;      // selectors healthy: bind() is authoritative — never guess by text
      const el = locateByText(target);
      if (el) target.el = el;
      return el;
    };
    const reveal = async () => {
      const el = find();
      if (!el) return false;
      flash(el);
      await glideTo(el, token);
      spyPausedUntil = Date.now() + 1200;
      lastJump.found = true;
      return true;
    };
    refresh(false);
    if (await reveal()) return;

    // Not rendered. claude.ai virtualizes the transcript (only a few rows exist at once), so:
    // estimate the scroll offset from the message index, look at what rendered, then correct — repeat.
    const sc = findScroller();
    setStatus("Locating message…");
    let stuck = 0, lastTop = -1;
    for (let s = 0; s < 80; s++) {
      if (token !== jumpToken) return;               // cancelled by a newer jump or the user scrolling
      lastJump.steps = s + 1;
      const idx = items.findIndex((m) => m.id === id);
      const range = Math.max(1, sc.scrollHeight - sc.clientHeight);
      const avg = sc.scrollHeight / Math.max(1, items.length);
      if (mode === "api") bind(); else refreshDom(false);
      const bound = [];
      items.forEach((m, i) => { if (m.el && m.el.isConnected) bound.push(i); });
      if (await reveal()) return;
      if (token !== jumpToken) return;

      let next;
      if (!bound.length) {
        // Nothing recognisable rendered (selectors changed?). Start at the proportional guess, then fan out around it.
        const est = (idx / Math.max(1, items.length - 1)) * range;
        next = est + (s % 2 ? 1 : -1) * Math.ceil(s / 2) * sc.clientHeight * 0.8;
      }
      else if (idx < bound[0]) next = sc.scrollTop - Math.max(sc.clientHeight * 0.6, (bound[0] - idx) * avg * 0.9);
      else if (idx > bound[bound.length - 1]) next = sc.scrollTop + Math.max(sc.clientHeight * 0.6, (idx - bound[bound.length - 1]) * avg * 0.9);
      else next = sc.scrollTop + (idx < bound[0] ? -1 : 1) * sc.clientHeight * 0.5;
      next = Math.min(range, Math.max(0, next));
      sc.scrollTop = next;
      await sleep(stuck ? stepDelay() * 2 : stepDelay());
      stuck = Math.abs(sc.scrollTop - lastTop) < 2 ? stuck + 1 : 0;
      lastTop = sc.scrollTop;
      if (stuck > 6) break;
    }
    toast("Couldn't reach that message — try again, or use the eye icon to read it");
  }

  // DOM-fallback only: scroll to the top repeatedly so the page loads older messages.
  let loading = false, cancelLoad = false;
  async function loadFullHistory(auto) {
    if (loading) { cancelLoad = true; return; }
    loading = true; cancelLoad = false;
    const stop = () => { cancelLoad = true; };
    ["wheel", "touchstart", "keydown"].forEach((ev) => window.addEventListener(ev, stop, { once: true, passive: true, capture: true }));
    const sc = findScroller();
    const before = sc.scrollHeight - sc.scrollTop;
    let stable = 0, last = -1, n = 0;
    try {
      while (!cancelLoad && stable < 4 && n++ < 300) {
        sc.scrollTop = 0;
        await sleep(350);
        refreshDom(false);
        setStatus(`Loading history… ${items.length} messages`);
        if (items.length === last && sc.scrollTop <= 2) stable++; else stable = 0;
        last = items.length;
      }
      refreshDom(true);
      sc.scrollTop = Math.max(0, sc.scrollHeight - before);
      setStatus(null);
      if (!auto || items.length) toast(cancelLoad ? `Stopped at ${items.length} messages` : `Loaded ${items.length} messages`);
    } finally {
      loading = false;
      ["wheel", "touchstart", "keydown"].forEach((ev) => window.removeEventListener(ev, stop, true));
    }
  }
  function setStatus(t) {
    const el = $("cn-count");
    if (!el) return;
    if (t) el.textContent = t; else updateStats();
  }

  function flash(el) {
    el.classList.remove("cn-highlight");
    void el.offsetWidth;
    el.classList.add("cn-highlight");
    setTimeout(() => el.classList.remove("cn-highlight"), 2200);
  }

  // Scroll-spy: highlight the message nearest the top of the viewport
  function startSpy() {
    const onScroll = (ev) => {
      const t = ev && ev.target;
      if (t && t.nodeType === 1 && t.closest && t.closest("#claude-nav-sidebar, #cn-reader")) return; // our own list scrolling
      if (Date.now() < spyPausedUntil) return;                                                       // programmatic jump in progress
      if (spyRaf) return;
      spyRaf = requestAnimationFrame(() => {
        spyRaf = 0;
        if (!items.length) return;
        const line = window.innerHeight * 0.3;
        let best = null, bestD = Infinity;
        for (const m of items) {
          if (!m.el || !m.el.isConnected) continue;
          const r = m.el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > window.innerHeight) continue;
          const d = r.top <= line && r.bottom >= line ? 0 : Math.min(Math.abs(r.top - line), Math.abs(r.bottom - line));
          if (d < bestD) { bestD = d; best = m; if (d === 0) break; }
        }
        if (best) setActive(best.id, !sidebarHovered);
      });
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  DIAGNOSTICS (structure only — never includes message text)
  // ═════════════════════════════════════════════════════════════════════════
  function describeEl(el) {
    if (!el) return null;
    return { tag: el.tagName, testid: el.getAttribute("data-testid"), cls: String(el.className || "").slice(0, 120), h: el.scrollHeight, ch: el.clientHeight };
  }
  function copyDiagnostics() {
    const sc = findScroller();
    const firstUser = document.querySelector(CFG.SEL.user), firstAsst = document.querySelector(CFG.SEL.asst);
    const sample = [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid"));
    const counts = {}; sample.forEach((t) => (counts[t] = (counts[t] || 0) + 1));
    const rep = {
      version: chrome.runtime.getManifest().version, path: location.pathname.replace(/[\w-]{20,}/g, "<id>"),
      mode, speed, items: items.length, boundToPage: items.filter((m) => m.el && m.el.isConnected).length,
      domUserMsgs: document.querySelectorAll(CFG.SEL.user).length, domAsstMsgs: document.querySelectorAll(CFG.SEL.asst).length,
      scroller: describeEl(sc), firstUser: describeEl(firstUser), firstAsst: describeEl(firstAsst),
      testids: counts, lastJump, ua: navigator.userAgent.slice(0, 80),
    };
    const txt = JSON.stringify(rep, null, 2);
    navigator.clipboard.writeText(txt).then(() => toast("Diagnostics copied — paste it in chat"), () => { openReaderText("Diagnostics", txt); });
    console.log("[Claude Navigator] diagnostics", rep);
  }
  function openReaderText(title, text) {
    readerId = null; $("cn-reader-title").textContent = title; $("cn-reader-body").textContent = text; $("cn-reader").hidden = false;
  }

  // One delegated click handler for every outline row (no per-row listeners).
  function handleListClick(e) {
    const row = e.target.closest(".cn-toc-item");
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest(".cn-save-single-btn")) { saveSingle(id); return; }
    if (e.target.closest(".cn-read-btn")) { toggleReader(id); return; }   // eye: show, tap again to hide
    jumpTo(id);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  READER — opens ONLY from the eye button; tapping the same eye again closes it
  // ═════════════════════════════════════════════════════════════════════════
  let readerId = null;
  const readerOpen = () => { const r = $("cn-reader"); return !!r && !r.hidden; };
  function toggleReader(id) {
    if (readerOpen() && readerId === id) closeReader(); else openReader(id);
  }
  function openReader(id) {
    const i = items.findIndex((m) => m.id === id);
    if (i < 0) return;
    readerId = id; setActive(id, true);
    const m = items[i];
    $("cn-reader-title").textContent = `#${i + 1} · ${m.role === "human" ? "You" : "Claude"}`;
    $("cn-reader-body").textContent = m.text;
    $("cn-reader-body").scrollTop = 0;
    $("cn-reader").hidden = false;
    lastRenderKey = ""; scheduleRender();                      // refresh eye highlight on rows
  }
  function closeReader() {
    const r = $("cn-reader");
    const was = readerId !== null;
    if (r) r.hidden = true;
    readerId = null;
    if (was) { lastRenderKey = ""; scheduleRender(); }
  }
  function readerStep(d) {
    const i = items.findIndex((m) => m.id === readerId);
    if (i >= 0 && items[i + d]) openReader(items[i + d].id);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  STORAGE (small, capped)
  // ═════════════════════════════════════════════════════════════════════════
  let persistTimer;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (!isChatPage() || !items.length) return;
      const url = location.href.split("#")[0];
      const entry = { url, title: cleanTitle(), savedAt: new Date().toISOString(), msgCount: items.length };
      try {
        chrome.storage.local.get("cn_index", ({ cn_index }) => {
          const idx = (cn_index || []).filter((e) => e.url !== url);
          idx.unshift(entry);
          chrome.storage.local.set({ cn_index: idx.slice(0, CFG.MAX_SAVED_CHATS) });
        });
      } catch (_) { /* extension context invalidated after update — ignore */ }
    }, 1500);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  EXPORT
  // ═════════════════════════════════════════════════════════════════════════
  function cleanTitle() {
    if (convTitle) return convTitle;
    return (document.title || "Claude Chat").replace(/\s*[-–|]\s*Claude\s*$/i, "").trim() || "Claude Chat";
  }
  const fileSafe = (s, n = 60) => s.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, n) || "claude-chat";

  function exportMarkdown() {
    if (!items.length) return toast("No messages to export");
    if (mode !== "api") refreshDom(true);
    const t = cleanTitle(), out = [`# ${t}\n\n> Exported ${new Date().toLocaleString()} · ${items.length} messages\n\n---\n\n## Outline\n`];
    items.forEach((m, i) => out.push(`${i + 1}. ${m.role === "human" ? "**You**" : "Claude"} — ${m.label.replace(/[\[\]]/g, "")}\n`));
    out.push("\n---\n\n");
    items.forEach((m, i) => out.push(`### ${i + 1}. ${m.role === "human" ? "You" : "Claude"}\n\n${m.text}\n\n---\n\n`));
    download(out.join(""), `${fileSafe(t)}.md`, "text/markdown;charset=utf-8");
    toast("Exported as Markdown");
  }

  function saveJSON() {
    if (!items.length) return toast("No messages to save");
    if (mode !== "api") refreshDom(true);
    const data = {
      title: cleanTitle(), url: location.href, exportedAt: new Date().toISOString(), messageCount: items.length,
      messages: items.map((m, i) => ({ index: i + 1, role: m.role, text: m.text })),
    };
    download(JSON.stringify(data, null, 2), `${fileSafe(data.title)}.json`, "application/json;charset=utf-8");
    toast("Saved as JSON");
  }

  function saveSingle(id) {
    const i = items.findIndex((m) => m.id === id);
    if (i < 0) return;
    const m = items[i];
    const body = `# ${cleanTitle()} — Message #${i + 1}\n\n**Role:** ${m.role === "human" ? "You" : "Claude"}\n**Saved:** ${new Date().toLocaleString()}\n\n---\n\n${m.text}\n`;
    download(body, `${fileSafe(cleanTitle(), 40)}-msg${i + 1}.md`, "text/markdown;charset=utf-8");
    toast(`Message #${i + 1} saved`);
  }

  function download(content, name, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  SIDEBAR OPEN/CLOSE, TOAST
  // ═════════════════════════════════════════════════════════════════════════
  function openSidebar() {
    sidebarVisible = true;
    const sb = $("claude-nav-sidebar");
    sb.classList.remove("cn-hidden");
    $("claude-nav-fab").classList.remove("cn-visible");
    sb.removeAttribute("inert");
    applyFilter();
    if (activeId) scrollTocTo(activeId);
    safeSet({ cn_sidebar_visible: true });
  }
  function closeSidebar() {
    sidebarVisible = false;
    const sb = $("claude-nav-sidebar");
    sb.classList.add("cn-hidden");
    sb.setAttribute("inert", "");
    $("claude-nav-fab").classList.add("cn-visible");
    safeSet({ cn_sidebar_visible: false });
  }
  function setPinned(v) {
    pinned = v;
    const b = $("cn-pin-btn");
    if (b) { b.classList.toggle("cn-pin-on", v); b.setAttribute("aria-pressed", String(v)); }
    safeSet({ cn_pinned: v });
  }
  const safeSet = (o) => { try { chrome.storage.local.set(o); } catch (_) {} };

  function toast(msg) {
    const c = $("cn-toast-container");
    if (!c) return;
    const t = document.createElement("div");
    t.className = "cn-toast";
    t.innerHTML = `${svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>')}<span>${esc(msg)}</span>`;
    c.appendChild(t);
    requestAnimationFrame(() => t.classList.add("cn-toast-visible"));
    setTimeout(() => { t.classList.replace("cn-toast-visible", "cn-toast-hiding"); setTimeout(() => t.remove(), 400); }, 2500);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  NAVIGATION (SPA)
  // ═════════════════════════════════════════════════════════════════════════
  async function loadChat() {
    const ok = await syncFromApi();
    if (ok) return;
    mode = "dom"; updateSource();
    [300, 900, 2000, 4000].forEach((d) => setTimeout(() => refreshDom(false), d));
    setTimeout(() => { if (isChatPage() && items.length && !loading) loadFullHistory(true); }, 4500);
  }

  function onNavigate() {
    const id = chatIdFromUrl();
    if (id === currentChatId) return;
    currentChatId = id;
    items = []; activeId = null; query = ""; roleFilter = "all"; mode = "none"; convTitle = "";
    lastDomCount = 0; closeReader();
    const s = $("cn-search"); if (s) s.value = "";
    applyFilter(); updateSource();
    if (id) loadChat();
  }

  // NOTE: content scripts live in an isolated world and can't hook the page's history.pushState,
  // so SPA navigation is detected by polling the URL (cheap) plus popstate.
  function watchNavigation() {
    window.addEventListener("popstate", onNavigate);
    setInterval(onNavigate, 700);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  UTIL + INIT
  // ═════════════════════════════════════════════════════════════════════════
  // Speed → timings. 5 = balanced default.
  const stepDelay = () => Math.round(330 - (speed - 1) * 30);                         // wait between locate steps (ms)
  const glideMs  = () => (speed >= 10 ? 0 : Math.round(1400 * Math.pow((10 - speed) / 9, 1.2))); // final glide duration (ms)
  function setSpeed(v, persistIt) {
    speed = Math.min(10, Math.max(1, Math.round(Number(v) || 5)));
    const r = $("cn-speed"), l = $("cn-speed-val");
    if (r) r.value = String(speed);
    if (l) l.textContent = String(speed);
    if (persistIt) safeSet({ cn_speed: speed });
  }
  function setSettingsOpen(open) {
    const p = $("cn-settings"), b = $("cn-settings-btn");
    if (!p || !b) return;
    p.hidden = !open;
    b.setAttribute("aria-expanded", String(open));
    b.classList.toggle("cn-pin-on", open);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function init() {
    buildUI();
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === "TOGGLE_SIDEBAR") sidebarVisible ? closeSidebar() : openSidebar();
      });
      chrome.storage.local.get(["cn_sidebar_visible", "cn_pinned", "cn_speed"], ({ cn_sidebar_visible, cn_pinned, cn_speed }) => {
        setPinned(!!cn_pinned);
        setSpeed(cn_speed || 5, false);
        cn_sidebar_visible === false ? closeSidebar() : openSidebar();
      });
    } catch (_) { openSidebar(); }

    applyFilter();
    startObserver();
    startSpy();
    watchNavigation();
    if (isChatPage()) loadChat();
    [800, 2000, 4000].forEach((d) => setTimeout(() => refresh(false), d));
  }

  init();
})();
