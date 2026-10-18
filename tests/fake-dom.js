'use strict';
/**
 * Minimal browser simulation — just enough DOM, events and selectors to run content.js unmodified.
 * Not a general-purpose DOM. Supported selectors: tag, #id, .class, [attr], [attr="v"], compounds of
 * those, and comma lists. Combinators (descendant ">" etc.) intentionally never match.
 */
const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function matchCompound(el, sel) {
  sel = sel.trim();
  if (!sel || /[\s>+~]/.test(sel.replace(/\[[^\]]*\]/g, ''))) return false;      // combinators: unsupported
  const re = /(\*)|^([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let m, any = false, pos = 0;
  while ((m = re.exec(sel))) {
    if (m.index !== pos) return false;
    pos = re.lastIndex; any = true;
    if (m[1]) continue;
    if (m[2] && el.tagName.toLowerCase() !== m[2].toLowerCase()) return false;
    if (m[3] && el.id !== m[3]) return false;
    if (m[4] && !el.classList.contains(m[4])) return false;
    if (m[5]) {
      if (!el.hasAttribute(m[5])) return false;
      const want = m[6] ?? m[7] ?? m[8];
      if (want !== undefined && el.getAttribute(m[5]) !== want) return false;
    }
  }
  return any && pos === sel.length;
}
const splitList = (s) => s.split(/,(?![^\[]*\])/);
const matchesList = (el, sel) => splitList(sel).some((p) => matchCompound(el, p));

class FNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { let n = this; while (n) { if (n === this.ownerDocument) return true; n = n.parentNode; } return false; }
}
class FText extends FNode {
  constructor(doc, t) { super(doc); this.nodeType = 3; this.nodeValue = t; }
  get textContent() { return this.nodeValue; }
}

class FElement extends FNode {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1; this.tagName = tag.toUpperCase();
    this._attrs = {}; this._listeners = {}; this.style = {};
    this.clientHeight = 0; this.scrollHeight = 0; this.scrollTop = 0; this.value = '';
    this._overflowY = 'visible'; this._display = 'block';
    const self = this, cls = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (c) => cls.has(c), replace: (a, b) => { if (cls.delete(a)) cls.add(b); },
      toggle: (c, f) => { const on = f === undefined ? !cls.has(c) : !!f; on ? cls.add(c) : cls.delete(c); return on; },
      get _set() { return cls; },
    };
    this.dataset = new Proxy({}, {
      get: (_, k) => self._attrs['data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())],
      set: (_, k, v) => { self._attrs['data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] = String(v); return true; },
    });
  }
  get id() { return this._attrs.id || ''; } set id(v) { this._attrs.id = String(v); }
  get className() { return [...this.classList._set].join(' '); }
  set className(v) { this.classList._set.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList._set.add(c)); }
  get hidden() { return 'hidden' in this._attrs; } set hidden(v) { v ? (this._attrs.hidden = '') : delete this._attrs.hidden; }
  get title() { return this._attrs.title || ''; } set title(v) { this._attrs.title = String(v); }
  setAttribute(k, v) { if (k === 'class') this.className = v; else this._attrs[k] = String(v); }
  getAttribute(k) { return k === 'class' ? this.className : (k in this._attrs ? this._attrs[k] : null); }
  hasAttribute(k) { return k in this._attrs; }
  removeAttribute(k) { delete this._attrs[k]; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes.forEach((c) => (c.parentNode = null)); this.childNodes = []; if (v !== '' && v != null) this.appendChild(new FText(this.ownerDocument, String(v))); }
  get innerText() { return this.textContent; }
  set innerHTML(html) { this.textContent = ''; parseInto(this, String(html)); }
  get innerHTML() { return ''; }
  _adopt(n) { if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1); n.parentNode = this; }
  appendChild(n) {
    if (n.tagName === '#FRAGMENT') { [...n.childNodes].forEach((c) => this.appendChild(c)); n.childNodes = []; return n; }
    this._adopt(n); this.childNodes.push(n); return n;
  }
  append(...ns) { ns.forEach((n) => this.appendChild(typeof n === 'string' ? new FText(this.ownerDocument, n) : n)); }
  replaceChildren(...ns) { this.childNodes.forEach((c) => (c.parentNode = null)); this.childNodes = []; this.append(...ns); }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
  compareDocumentPosition(o) {
    const order = []; const walk = (n) => { order.push(n); n.childNodes.forEach(walk); }; walk(this.ownerDocument);
    const a = order.indexOf(this), b = order.indexOf(o); return a === b ? 0 : (b > a ? 4 : 2);
  }
  contains(o) { for (let n = o; n; n = n.parentNode) if (n === this) return true; return false; }
  matches(sel) { return matchesList(this, sel); }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matchesList(n, sel)) return n; return null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => n.childNodes.forEach((c) => { if (c.nodeType === 1) { if (matchesList(c, sel)) out.push(c); walk(c); } }); walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return this._rect || { top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0 }; }
  scrollIntoView() {}
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() {
    if (this.tagName === 'A' && this.download && this.ownerDocument._onDownload) this.ownerDocument._onDownload({ name: this.download, href: this.href });
    this.dispatchEvent({ type: 'click', bubbles: true });
  }
  addEventListener(type, fn, opts) { addL(this, type, fn, opts); }
  removeEventListener(type, fn, opts) { removeL(this, type, fn, opts); }
  dispatchEvent(ev) { return dispatch(this, ev); }
}

const capOf = (o) => o === true || !!(o && o.capture === true);
function addL(t, type, fn, opts) { (t._listeners[type] = t._listeners[type] || []).push({ fn, capture: capOf(opts), once: !!(opts && opts.once) }); }
function removeL(t, type, fn, opts) { const l = t._listeners[type]; if (l) t._listeners[type] = l.filter((x) => !(x.fn === fn && x.capture === capOf(opts))); }
function dispatch(target, ev) {
  ev.target = target; ev.defaultPrevented = false; ev._stop = false;
  ev.preventDefault = () => { ev.defaultPrevented = true; }; ev.stopPropagation = () => { ev._stop = true; };
  const path = []; for (let n = target; n; n = n._eventParent ? n._eventParent() : n.parentNode) path.push(n);
  const fire = (n, cap) => {
    ev.currentTarget = n;
    (n._listeners && n._listeners[ev.type] || []).slice().forEach((l) => { if (l.capture === cap && !ev._stop) { if (l.once) removeL(n, ev.type, l.fn, { capture: l.capture }); l.fn.call(n, ev); } });
  };
  for (let i = path.length - 1; i >= 0 && !ev._stop; i--) fire(path[i], true);
  for (let i = 0; i < path.length && !ev._stop; i++) { fire(path[i], false); if (ev.bubbles === false) break; }   // target always fires; ancestors only if it bubbles
  return !ev.defaultPrevented;
}

function parseInto(parent, html) {
  const doc = parent.ownerDocument, stack = [parent];
  const re = /<!--[\s\S]*?-->|<\/(\w+)\s*>|<(\w+)((?:\s+[^\s=>\/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (m[2]) {
      const el = doc.createElement(m[2].toLowerCase());
      const ar = /([^\s=>\/]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g; let a;
      while ((a = ar.exec(m[3] || ''))) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
      stack[stack.length - 1].appendChild(el);
      if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(el);
      continue;
    }
    if (m[5] != null) stack[stack.length - 1].appendChild(new FText(doc, decode(m[5])));
  }
}

function createWindowAndDocument() {
  const win = { _listeners: {}, innerHeight: 800, scrollBy() {}, addEventListener(t, f, o) { addL(win, t, f, o); }, removeEventListener(t, f, o) { removeL(win, t, f, o); }, dispatchEvent(e) { return dispatch(win, e); } };
  const doc = new FElement(null, '#document'); doc.nodeType = 9; doc.ownerDocument = doc; doc._eventParent = () => win;
  const html = new FElement(doc, 'html'), body = new FElement(doc, 'body');
  doc.appendChild(html); html.appendChild(body);
  Object.assign(doc, {
    documentElement: html, body, scrollingElement: html, activeElement: body, cookie: '', _title: 'Chat - Claude',
    createElement: (t) => (t === '#fragment' ? Object.assign(new FElement(doc, 'x'), { tagName: '#FRAGMENT' }) : new FElement(doc, t)),
    createDocumentFragment: () => Object.assign(new FElement(doc, 'x'), { tagName: '#FRAGMENT' }),
    getElementById: (id) => html.querySelectorAll('#' + id)[0] || null,
    querySelector: (s) => html.querySelector(s), querySelectorAll: (s) => html.querySelectorAll(s),
    createTreeWalker: (root, _what, filter) => {
      const nodes = []; const walk = (n) => n.childNodes.forEach((c) => { if (c.nodeType === 3 && (!filter || filter.acceptNode(c) === 1)) nodes.push(c); else if (c.nodeType === 1) walk(c); }); walk(root);
      let i = -1; return { get currentNode() { return nodes[i]; }, nextNode() { return ++i < nodes.length; } };
    },
  });
  Object.defineProperty(doc, 'title', { get: () => doc._title, set: (v) => { doc._title = v; } });
  return { win, doc };
}

module.exports = { createWindowAndDocument, FElement, FText };
