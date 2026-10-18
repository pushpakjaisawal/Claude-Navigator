'use strict';
/**
 * Test harness: runs the REAL content.js inside a vm context wired to fake-dom + stubs.
 *   const env = await createEnv({ messages, ... });
 *   env.cn('items.length')        // evaluate any expression inside content.js's closure
 *   env.click(el) / env.key(...)  // simulate user input
 *   env.dispose()                 // clear timers
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createWindowAndDocument } = require('./fake-dom');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(process.env.CN_SRC || path.join(ROOT, 'content.js'), 'utf8');   // CN_SRC: debug override
const HOOK = '\n  globalThis.__cn = (c) => eval(c);\n  init();\n})();';
if (!/\n  init\(\);\n\}\)\(\);\s*$/.test(SRC)) throw new Error('content.js must end with "init();\\n})();" (test hook anchor)');
const INSTRUMENTED = SRC.replace(/\n  init\(\);\n\}\)\(\);\s*$/, HOOK);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a claude.ai-style conversation API payload (linear chain, optional abandoned branch). */
function makeConversation(messages, { name = 'Test chat', branch = false } = {}) {
  const chat_messages = [];
  messages.forEach((m, i) => chat_messages.push({
    uuid: 'msg-' + i, sender: m.role === 'human' ? 'human' : 'assistant', index: i,
    parent_message_uuid: i ? 'msg-' + (i - 1) : '00000000-0000-4000-8000-000000000000',
    content: [{ type: 'text', text: m.text }], created_at: '2026-01-01T00:00:00Z',
  }));
  if (branch && messages.length > 2) chat_messages.push({ uuid: 'abandoned', sender: 'human', index: 2, parent_message_uuid: 'msg-1', content: [{ type: 'text', text: 'ABANDONED BRANCH TEXT' }] });
  return { uuid: 'abc', name, chat_messages, current_leaf_message_uuid: 'msg-' + (messages.length - 1) };
}

/** Deterministic pseudo-random message set: alternating human/assistant with unique text. */
function makeMessages(n, seed = 1) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return [...Array(n)].map((_, i) => ({
    role: i % 2 === 0 ? 'human' : 'assistant',
    text: (i % 2 === 0
      ? `Question ${i} about topic${i} ${'detail '.repeat(1 + Math.floor(rnd() * 5))}`
      : `## Answer ${i}\nHere is the **result** for topic${i} with \`code\` ${'sentence. '.repeat(1 + Math.floor(rnd() * 8))}`).trim(),
  }));
}

async function createEnv(opts = {}) {
  const {
    pathname = '/chat/abc', messages = null, conversation = null, orgs = ['org1'], badOrgs = [],
    apiDown = false, storage = {}, mountPage = true, renderDelay = 0, rowHeights = null, autoInit = true, selectorless = false,
  } = opts;
  const { win, doc } = createWindowAndDocument();
  const timers = new Set();
  const track = (fn) => (cb, ms, ...a) => { const h = fn(cb, ms, ...a); timers.add(h); return h; };
  const downloads = [], clipboard = [], fetchLog = [];
  const store = { ...storage };
  const convo = conversation || (messages ? makeConversation(messages) : null);

  const chrome = {
    storage: { local: {
      get(keys, cb) {
        const out = {}; const ks = keys == null ? Object.keys(store) : [].concat(keys);
        ks.forEach((k) => { if (k in store) out[k] = store[k]; });
        if (cb) cb(out); return Promise.resolve(out);
      },
      set(obj, cb) { Object.assign(store, obj); if (cb) cb(); return Promise.resolve(); },
    } },
    runtime: { onMessage: { _l: [], addListener(f) { this._l.push(f); } }, getManifest: () => JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')) },
  };

  const location = { pathname, href: 'https://claude.ai' + pathname };
  const fetchStub = async (url) => {
    fetchLog.push(String(url));
    if (apiDown) return { ok: false, status: 500, json: async () => ({}) };
    if (String(url) === '/api/organizations') return { ok: true, json: async () => orgs.map((u) => ({ uuid: u })) };
    const m = String(url).match(/\/api\/organizations\/([^/]+)\/chat_conversations\/([^?]+)/);
    if (m && convo && !badOrgs.includes(m[1])) return { ok: true, json: async () => convo };
    return { ok: false, status: 403, json: async () => ({}) };
  };

  const sandbox = {
    window: win, document: doc, location, chrome, fetch: fetchStub, console, performance,
    Blob, URL: Object.assign(function () {}, { createObjectURL: (b) => { downloads.push({ blob: b }); return 'blob:test'; }, revokeObjectURL() {} }),
    navigator: { userAgent: 'TestAgent/1.0', clipboard: { writeText: (t) => { clipboard.push(t); return Promise.resolve(); } } },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} },
    getComputedStyle: (el) => ({ display: el._display || 'block', overflowY: el._overflowY || 'visible' }),
    requestAnimationFrame: (cb) => track(setTimeout)(() => cb(performance.now()), 0),
    setTimeout: track(setTimeout), setInterval: track(setInterval), clearTimeout, clearInterval,
  };
  doc._onDownload = (d) => { const last = downloads[downloads.length - 1]; if (last) last.name = d.name; };
  vm.createContext(sandbox);
  win.document = doc; win.location = location;

  let page = null;
  if (mountPage) page = mountTranscript(doc, messages || [], { renderDelay, rowHeights, selectorless });

  const env = {
    ctx: sandbox, win, doc, store, downloads, clipboard, fetchLog, location, page, wait, chrome,
    cn: (code) => sandbox.__cn(code),
    load() { vm.runInContext(INSTRUMENTED, sandbox, { filename: 'content.js' }); },
    el: (id) => doc.getElementById(id),
    click(el) { el.click(); },
    key(key, { target = doc.activeElement, ...mods } = {}) { const ev = { type: 'keydown', key, bubbles: true, ...mods }; target.dispatchEvent(ev); return ev; },
    rows() { return doc.querySelectorAll('.cn-toc-item'); },
    toasts() { return (doc.getElementById('cn-toast-container')?.childNodes || []).map((t) => t.textContent); },
    dispose() { timers.forEach((h) => { clearTimeout(h); clearInterval(h); }); timers.clear(); },
    setPath(p) { location.pathname = p; location.href = 'https://claude.ai' + p; },
    async settle(ms = 400) { await wait(ms); },
  };
  if (autoInit) { env.load(); await wait(60); }
  return env;
}

/**
 * Simulate claude.ai's virtualized transcript: ONE tall scroll container, only ~3 rows rendered at a time.
 * Row heights vary (like real markdown), so scroll-position estimation has to cope with irregularity.
 */
function mountTranscript(doc, messages, { renderDelay = 0, rowHeights = null, selectorless = false } = {}) {
  const main = doc.createElement('main'); doc.body.append(main);
  const scroller = doc.createElement('div'); main.append(scroller);
  scroller._overflowY = 'auto'; scroller.clientHeight = 587;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 587, height: 587, left: 0, right: 800, width: 800 });
  const list = doc.createElement('div'); list.setAttribute('data-testid', 'transcript-list'); scroller.append(list);

  const n = messages.length;
  const heights = rowHeights || messages.map((_, i) => 400 + ((i * 7919) % 1900));       // 400..2300px, irregular
  const offs = [0]; heights.forEach((h) => offs.push(offs[offs.length - 1] + h));
  scroller.scrollHeight = offs[n] || 0;

  const els = new Map(); let top = scroller.scrollHeight ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
  const indexAt = (y) => { let i = 0; while (i < n - 1 && offs[i + 1] <= y) i++; return i; };
  function msgEl(i) {
    if (els.has(i)) return els.get(i);
    const e = doc.createElement('div');
    if (!selectorless) e.setAttribute('data-testid', messages[i].role === 'human' ? 'user-message' : 'assistant-message');   // selectorless = simulate claude.ai renaming its markup
    e.textContent = messages[i].text.replace(/[#*`]/g, '');                   // rendered markdown: symbols gone
    e.getBoundingClientRect = () => ({ top: offs[i] - top, bottom: offs[i + 1] - top, height: heights[i], left: 0, right: 700, width: 700 });
    e.scrollIntoView = () => { const m = parseInt(e.style.scrollMarginTop || '0', 10) || 0; scrollerSet(offs[i] - m); };
    els.set(i, e); return e;
  }
  function render() {
    list.replaceChildren();
    if (!n) return;
    const c = indexAt(top);
    for (let i = Math.max(0, c - 1); i <= Math.min(n - 1, c + 1); i++) {
      const row = doc.createElement('div'); row.setAttribute('data-testid', 'transcript-row'); row.append(msgEl(i)); list.append(row);
    }
  }
  function scrollerSet(v) { top = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, v)); renderDelay ? setTimeout(render, renderDelay) : render(); scroller.dispatchEvent({ type: 'scroll', bubbles: false }); }
  Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: scrollerSet });
  render();
  return { scroller, list, offs, heights, msgEl, render, topOf: (i) => offs[i] - top, get scrollTop() { return top; }, set scrollTop(v) { scrollerSet(v); } };
}

module.exports = { createEnv, makeConversation, makeMessages, mountTranscript, wait, ROOT };
