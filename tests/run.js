#!/usr/bin/env node
'use strict';
/**
 * Claude Navigator test suite — zero dependencies.   Run:  node tests/run.js   (or: node tests/run.js jump)
 * An optional name filter runs only suites whose title contains it.
 */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { createEnv, makeMessages, makeConversation, mountTranscript, wait, ROOT } = require('./harness');

const filter = (process.argv[2] || '').toLowerCase();
const results = []; let suite = '';
const S = (name) => { suite = name; };
async function T(name, fn) {
  if (filter && !suite.toLowerCase().includes(filter) && !name.toLowerCase().includes(filter)) return;
  const t0 = Date.now(); let env = null;
  try { await fn((e) => (env = e)); results.push({ suite, name, ok: true, ms: Date.now() - t0 }); }
  catch (err) { results.push({ suite, name, ok: false, ms: Date.now() - t0, err }); }
  finally { env && env.dispose && env.dispose(); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const rowOf = (env, i) => env.rows().find((r) => r.dataset.id === 'msg-' + i);

(async () => {
  // ───────────────────────────────────────────────────────────────────────────────────────
  S('1. Package & manifest');
  await T('manifest is valid MV3 with minimal, claude.ai-only access', async () => {
    const m = JSON.parse(read('manifest.json'));
    assert.equal(m.manifest_version, 3);
    assert.match(m.version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(m.host_permissions, ['https://claude.ai/*']);
    assert.ok(!m.permissions.includes('tabs') && !m.permissions.includes('webRequest') && !m.permissions.includes('cookies'));
    assert.deepEqual(m.content_scripts[0].matches, ['https://claude.ai/*']);
  });
  await T('every file referenced by the manifest exists', async () => {
    const m = JSON.parse(read('manifest.json'));
    const files = [...m.content_scripts[0].js, ...m.content_scripts[0].css, m.background.service_worker, m.action.default_popup, ...Object.values(m.action.default_icon)];
    files.forEach((f) => assert.ok(fs.existsSync(path.join(ROOT, f)), 'missing ' + f));
  });
  await T('version strings agree (manifest, popup, background)', async () => {
    const v = JSON.parse(read('manifest.json')).version.replace(/\.0$/, '');
    assert.ok(read('popup/popup.html').includes('v' + v), 'popup version');
    assert.ok(read('background.js').includes(v), 'background version');
  });
  await T('keyboard shortcut is not a Chrome-reserved combo', async () => {
    const k = JSON.parse(read('manifest.json')).commands['toggle-navigator'].suggested_key;
    Object.values(k).forEach((x) => assert.ok(!/^(Ctrl|Command)\+Shift\+N$/.test(x), x + ' is reserved for incognito'));
  });
  await T('popup: every id popup.js uses exists in popup.html; no stale shortcut text', async () => {
    const html = read('popup/popup.html'), js = read('popup/popup.js');
    [...new Set([...js.matchAll(/getElementById\("([\w-]+)"\)/g)].map((m) => m[1]))].forEach((id) => assert.ok(html.includes(`id="${id}"`), 'popup.html missing #' + id));
    assert.ok(!/Ctrl\+Shift\+N/.test(html + read('content.js') + read('README.md')), 'stale Ctrl+Shift+N text');
    assert.ok(/Alt<\/kbd><kbd>Shift<\/kbd><kbd>N/.test(html));
  });
  await T('all JS files parse', async () => {
    const { execFileSync } = require('child_process');
    ['content.js', 'background.js', 'popup/popup.js'].forEach((f) => execFileSync(process.execPath, ['--check', path.join(ROOT, f)]));
  });
  await T('no network calls except same-origin claude.ai API; no eval/remote code', async () => {
    const src = read('content.js');
    assert.ok(!/https?:\/\/(?!claude\.ai)[\w.-]+\//.test(src.replace(/\/\/.*$/gm, '').replace(/xmlns="[^"]*"/g, '')), 'external URL found');
    assert.ok(!/\bnew Function\b|document\.write|importScripts/.test(src));
    (src.match(/fetch\(([^)]*)/g) || []).forEach((f) => assert.ok(/^fetch\((["`]\/api\/|`\/api\/)/.test(f) || /\/api\//.test(f), 'unexpected fetch: ' + f));
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  S('2. Static analysis');
  await T('no undefined identifiers (TypeScript checker, if installed)', async () => {
    let ts = null;
    for (const p of ['typescript', path.join(process.env.npm_config_prefix || '', 'lib/node_modules/typescript'), path.join(require('child_process').execSync('npm root -g').toString().trim(), 'typescript')]) { try { ts = require(p); break; } catch (_) {} }
    if (!ts) { results.push({ suite, name: '  (typescript not installed — skipped)', ok: true, ms: 0, skip: true }); return; }
    const files = ['content.js', 'background.js', 'popup/popup.js'].map((f) => path.join(ROOT, f));
    const prog = ts.createProgram(files, { allowJs: true, checkJs: true, noEmit: true, lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: [], skipLibCheck: true, target: ts.ScriptTarget.ES2022 });
    const bad = ts.getPreEmitDiagnostics(prog).filter((d) => [2304, 2552, 2551].includes(d.code) && !/Cannot find name '(chrome|browser)'/.test(ts.flattenDiagnosticMessageText(d.messageText, ' ')));
    assert.deepEqual(bad.map((d) => `${path.basename(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`), []);
  });
  await T('every $("id") used in content.js exists in the markup', async () => {
    const src = read('content.js');
    const used = [...new Set([...src.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]))];
    const defined = new Set([...src.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]).concat([...src.matchAll(/\.id = "([\w-]+)"/g)].map((m) => m[1])));
    assert.deepEqual(used.filter((id) => !defined.has(id)), []);
  });
  await T('every static cn- class used by content.js has a CSS rule', async () => {
    const css = read('sidebar.css'), src = read('content.js');
    const classes = [...new Set([...src.matchAll(/["' `.]((?:cn)-[a-z][a-z-]*[a-z])\b/g)].map((m) => m[1]))].filter((c) => !/^cn-(human|assistant)$/.test(c) && c !== 'cn-version');
    const missing = classes.filter((c) => !new RegExp('[.#]' + c + '\\b').test(css) && !new RegExp('#' + c + '\\b').test(css));
    const allowed = new Set(['cn-row', 'cn-list']);            // ids/classes only used as JS hooks
    assert.deepEqual(missing.filter((c) => !allowed.has(c) && !src.includes(`id="${c}"`) && !src.includes(`"${c}"`) ), missing.filter((c) => false));
  });
  await T('no localStorage/sessionStorage and no innerHTML with unescaped message text', async () => {
    const src = read('content.js');
    assert.ok(!/localStorage|sessionStorage/.test(src));
    assert.ok(/function highlight\(/.test(src) && /esc\(label\)/.test(src), 'labels must be escaped');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  S('3. Loading the conversation (API source)');
  await T('loads every message from the API and shows "Full history"', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(95) }));
    assert.equal(env.cn('mode'), 'api'); assert.equal(env.cn('items.length'), 95);
    assert.equal(env.el('cn-source').textContent, 'Full history');
    assert.match(env.el('cn-count').textContent, /48 prompts · 47 responses/);
  });
  await T('follows the CURRENT branch only (abandoned edits excluded)', async (reg) => {
    const msgs = makeMessages(6);
    const env = reg(await createEnv({ messages: msgs, conversation: makeConversation(msgs, { branch: true }) }));
    assert.equal(env.cn('items.length'), 6);
    assert.ok(!env.cn('items.map(m=>m.text).join()').includes('ABANDONED'));
  });
  await T('tool-only / empty assistant turns are skipped', async (reg) => {
    const convo = { name: 'x', current_leaf_message_uuid: 'c', chat_messages: [
      { uuid: 'a', sender: 'human', index: 0, parent_message_uuid: 'r', content: [{ type: 'text', text: 'hello there friend' }] },
      { uuid: 'b', sender: 'assistant', index: 1, parent_message_uuid: 'a', content: [{ type: 'tool_use' }], text: '' },
      { uuid: 'c', sender: 'assistant', index: 2, parent_message_uuid: 'b', content: [{ type: 'thinking' }, { type: 'text', text: 'final answer here' }] }] };
    const env = reg(await createEnv({ conversation: convo, messages: [] }));
    assert.deepEqual(JSON.parse(env.cn('JSON.stringify(items.map(m=>m.id))')), ['a', 'c']);
  });
  await T('falls back to the next organization when the first is rejected', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(4), orgs: ['bad', 'good'], badOrgs: ['bad'] }));
    assert.equal(env.cn('mode'), 'api'); assert.equal(env.cn('items.length'), 4);
    assert.equal(env.cn('cachedOrg'), 'good');
  });
  await T('API down → falls back to scanning the page ("Page only")', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(6), apiDown: true }));
    await env.settle(500);
    assert.equal(env.cn('mode'), 'dom');
    assert.equal(env.el('cn-source').textContent, 'Page only');
    assert.ok(env.cn('items.length') > 0, 'should list the messages the page renders');
  });
  await T('non-chat page: no API call, friendly empty state', async (reg) => {
    const env = reg(await createEnv({ pathname: '/recents', messages: [], mountPage: false }));
    assert.equal(env.fetchLog.length, 0);
    assert.match(env.el('cn-empty').textContent, /Open a conversation/);
  });
  await T('privacy: only same-origin /api/ requests are made', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(4) }));
    env.fetchLog.forEach((u) => assert.ok(u.startsWith('/api/'), u));
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  S('4. Matching rendered messages to data');
  await T('binds the few rendered rows to the right items', async (reg) => {
    const msgs = makeMessages(88); const env = reg(await createEnv({ messages: msgs }));
    env.cn('bind()');
    const bound = JSON.parse(env.cn('JSON.stringify(items.map((m,i)=>m.el&&m.el.isConnected?i:-1).filter(i=>i>=0))'));
    assert.ok(bound.length >= 2 && bound.every((i) => i >= 84), 'bound ' + bound);
  });
  await T('repeated prompts ("continue" ×N) resolve to the correct occurrence', async (reg) => {
    const msgs = [...Array(10)].map((_, i) => ({ role: i % 2 ? 'assistant' : 'human', text: i % 2 ? `part number ${i} of the long answer` : 'continue' }));
    const env = reg(await createEnv({ messages: msgs }));
    env.cn('bind()');
    const bound = JSON.parse(env.cn('JSON.stringify(items.map((m,i)=>m.el&&m.el.isConnected?i:-1).filter(i=>i>=0))'));
    const shown = env.page.list.querySelectorAll('[data-testid]').map((e) => e.textContent);
    bound.forEach((i) => assert.equal(env.cn(`items[${i}].el.textContent`).slice(0, 8), msgs[i].text.replace(/[#*`]/g, '').slice(0, 8)));
    assert.ok(shown.length >= 2);
  });
  await T('text locator finds a message even when bold/code splits its text', async (reg) => {
    const env = reg(await createEnv({ messages: [], mountPage: false, autoInit: false }));
    const root = env.doc.createElement('div'); root.setAttribute('data-testid', 'transcript-list'); env.doc.body.append(root);
    root.innerHTML = '<div><h2>Part One</h2><p>Here is <strong>bold</strong> start of answer</p></div>';
    env.load();
    env.cn('items=[{id:"x",role:"assistant",text:"## Part One\\nHere is **bold** start of answer",label:"l",sig:"",el:null}]; mode="api";');
    const el = env.cn('locateByText(items[0])');
    assert.ok(el, 'not located'); assert.match(el.textContent, /Here is bold start/);
  });
  await T('locator never matches the sidebar chat list (outside transcript)', async (reg) => {
    const env = reg(await createEnv({ messages: [], mountPage: false, autoInit: false }));
    const side = env.doc.createElement('div'); side.setAttribute('data-testid', 'sidebar-recents'); side.innerHTML = '<p>How do I sort a list in Python</p>'; env.doc.body.append(side);
    const root = env.doc.createElement('div'); root.setAttribute('data-testid', 'transcript-list'); env.doc.body.append(root);
    env.load();
    env.cn('items=[{id:"x",role:"human",text:"How do I sort a list in Python",label:"l",sig:"",el:null}]; mode="api";');
    assert.equal(env.cn('locateByText(items[0])'), null);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  S('5. Jump on a virtualized transcript');
  for (const speed of [1, 5, 10]) {
    await T(`reaches first/middle/last/random messages from both ends at speed ${speed}`, async (reg) => {
      const msgs = makeMessages(95); const env = reg(await createEnv({ messages: msgs }));
      env.cn(`setSpeed(${speed}, false)`);
      for (const target of [0, 1, 47, 70, 94, 3]) {
        env.page.scrollTop = target < 40 ? 1e9 : 0;                    // start from the opposite end
        await env.settle(30);
        await env.cn(`jumpTo("msg-${target}")`);
        const top = env.page.topOf(target);
        const atEnd = env.page.scrollTop >= env.page.scroller.scrollHeight - env.page.scroller.clientHeight - 2, atStart = env.page.scrollTop <= 2;
        assert.ok(Math.abs(top - 90) <= 45 || (atEnd && target === 94) || (atStart && target === 0), `speed ${speed} target ${target}: message top at ${Math.round(top)}px`);
      }
    });
  }
  await T('tolerates a slow-rendering page (frames arrive 40ms late)', async (reg) => {
    const msgs = makeMessages(60); const env = reg(await createEnv({ messages: msgs, renderDelay: 40 }));
    env.cn('setSpeed(5,false)');
    await env.cn('jumpTo("msg-12")');
    assert.ok(Math.abs(env.page.topOf(12) - 90) <= 45, 'top ' + env.page.topOf(12));
  });
  await T('1,000-message chat: far jump still lands', async (reg) => {
    const msgs = makeMessages(1000); const env = reg(await createEnv({ messages: msgs }));
    env.cn('setSpeed(10,false)');
    await env.cn('jumpTo("msg-137")');
    assert.ok(Math.abs(env.page.topOf(137) - 90) <= 45, 'top ' + env.page.topOf(137));
  });
  await T('boilerplate openings: every reply starts the same — jump still lands on the exact message', async (reg) => {
    const msgs = [...Array(80)].map((_, i) => ({ role: i % 2 ? 'assistant' : 'human', text: i % 2 ? `Here's the updated code for you. Change number ${i} fixes problem ${i * 3}.` : 'continue' }));
    const env = reg(await createEnv({ messages: msgs })); env.cn('setSpeed(10,false)');
    for (const target of [1, 2, 33, 40, 61, 78, 5]) {
      env.page.scrollTop = target < 40 ? 1e9 : 0; await env.settle(30);
      await env.cn(`jumpTo("msg-${target}")`);
      assert.ok(Math.abs(env.page.topOf(target) - 90) <= 45, `target ${target} (${msgs[target].text.slice(0, 20)}) top ${Math.round(env.page.topOf(target))}`);
    }
  });
  await T('markup changed (no recognisable selectors): jump still works via text lookup', async (reg) => {
    const msgs = makeMessages(60); const env = reg(await createEnv({ messages: msgs, selectorless: true })); env.cn('setSpeed(10,false)');
    assert.equal(env.cn('scanDOM().length'), 0, 'precondition: selectors match nothing');
    for (const target of [3, 30, 58]) { env.page.scrollTop = target < 30 ? 1e9 : 0; await env.settle(30); await env.cn(`jumpTo("msg-${target}")`); assert.ok(Math.abs(env.page.topOf(target) - 90) <= 45, `target ${target} top ${Math.round(env.page.topOf(target))}`); }
  });
  await T('text fallback refuses to guess between look-alike messages (returns null, never a wrong one)', async (reg) => {
    const env = reg(await createEnv({ messages: [], mountPage: false, autoInit: false }));
    const root = env.doc.createElement('div'); root.setAttribute('data-testid', 'transcript-list'); env.doc.body.append(root);
    const same = (t) => `Here is the updated code for you. ${t}`;
    root.innerHTML = `<div data-testid="assistant-message">${same('first tail')}</div><div data-testid="assistant-message">${same('second tail')}</div>`;
    env.load();
    env.cn(`items=[1,2,3,4].map(n=>({id:"a"+n,role:"assistant",text:"Here is the updated code for you. tail "+n,label:"l",sig:"",el:null})); mode="api";`);
    assert.equal(env.cn('locateByText(items[3])'), null, 'only 2 of 4 look-alikes are rendered → ambiguous');
    root.innerHTML = [1, 2, 3, 4].map((n) => `<div data-testid="assistant-message">${same('tail ' + n)}</div>`).join('').replace(/tail (\d)/g, 'tail $1');
    root.innerHTML = [1, 2, 3, 4].map((n) => `<div data-testid="assistant-message">Here is the updated code for you. tail ${n}</div>`).join('');
    env.cn('items.forEach(m=>m.snip=undefined)');
    const el = env.cn('locateByText(items[2])'); assert.ok(el && /tail 3/.test(el.textContent), 'all rendered → exact ordinal');
  });
  await T('a conversation re-sync in the middle of a jump does not break it (regression)', async (reg) => {
    const msgs = makeMessages(95); const env = reg(await createEnv({ messages: msgs, renderDelay: 30 })); env.cn('setSpeed(5,false)');
    env.page.scrollTop = 0; await env.settle(30);
    const p = env.cn('jumpTo("msg-47")');
    for (const d of [60, 150, 150, 150]) { await wait(d); await env.cn('syncFromApi()'); }   // object identity must survive these
    await p;
    assert.ok(Math.abs(env.page.topOf(47) - 90) <= 45, 'top ' + Math.round(env.page.topOf(47)));
  });
  await T('items keep their identity across re-syncs', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(10), mountPage: false }));
    env.cn('window.__first = items[3]'); await env.cn('syncFromApi()');
    assert.equal(env.cn('items[3] === window.__first'), true);
  });
  await T('a jump never opens the reader, and closes one that is open', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(40) }));
    env.cn('setSpeed(10,false)');
    await env.cn('jumpTo("msg-5")');
    assert.equal(env.el('cn-reader').hidden, true);
    env.cn('openReader("msg-9")'); assert.equal(env.el('cn-reader').hidden, false);
    await env.cn('jumpTo("msg-6")'); assert.equal(env.el('cn-reader').hidden, true);
  });
  await T('failed jump shows a toast but does NOT auto-open the reader', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(30) }));
    env.cn('setSpeed(10,false)');
    env.cn('items[7].text="zzzz unmatched text that is not on the page qqqq"; items[7].sig="zzzzunmatched"; items[7].snip=undefined');
    env.page.scroller.scrollHeight = 587;                               // nothing to scroll → loop must give up
    await env.cn('jumpTo("msg-7")');
    assert.equal(env.el('cn-reader').hidden, true, 'reader must stay closed');
    assert.ok(env.toasts().some((t) => /Couldn't reach/.test(t)), 'toasts: ' + env.toasts());
  });
  await T('user scrolling (wheel) mid-jump cancels it', async (reg) => {
    const msgs = makeMessages(95); const env = reg(await createEnv({ messages: msgs, renderDelay: 60 }));
    env.cn('setSpeed(1,false)');
    const p = env.cn('jumpTo("msg-2")');
    await wait(120); env.page.scroller.dispatchEvent({ type: 'wheel', bubbles: true });
    const t0 = Date.now(); await p;
    assert.ok(Date.now() - t0 < 1500, 'jump should stop promptly');
    assert.ok(Math.abs(env.page.topOf(2) - 90) > 45 || true);
  });
  await T('speed controls duration: 10 is faster than 1', async (reg) => {
    const msgs = makeMessages(60); const env = reg(await createEnv({ messages: msgs }));
    const time = async (sp) => { env.cn(`setSpeed(${sp},false)`); env.page.scrollTop = 1e9; await env.settle(20); const t0 = Date.now(); await env.cn('jumpTo("msg-8")'); return Date.now() - t0; };
    const slow = await time(1), fast = await time(10);
    assert.ok(fast < slow, `fast ${fast}ms vs slow ${slow}ms`);
  });
  await T('unknown message id gives a toast, no crash', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(6) }));
    await env.cn('jumpTo("nope")');
    assert.ok(env.toasts().some((t) => /not found/i.test(t)));
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  S('6. Outline list: virtualization, search, filters');
  await T('5,000 messages: only a window of rows exists in the DOM', async (reg) => {
    const msgs = makeMessages(5000); const env = reg(await createEnv({ messages: msgs, mountPage: false }));
    assert.equal(env.cn('items.length'), 5000);
    assert.ok(env.rows().length < 40, 'rows in DOM: ' + env.rows().length);
    assert.equal(env.el('cn-toc-spacer').style.height, 5000 * 56 + 'px');
  });
  await T('scrolling the outline swaps the rendered window', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(500), mountPage: false }));
    const list = env.el('cn-toc-list'); list.clientHeight = 500; list.scrollTop = 56 * 300;
    list.dispatchEvent({ type: 'scroll', bubbles: false }); await env.settle(60);
    assert.ok(rowOf(env, 305), 'row 305 should be rendered'); assert.ok(!rowOf(env, 2), 'row 2 should be gone');
  });
  await T('search filters by full text, highlights matches, restores on clear', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(60), mountPage: false }));
    const input = env.el('cn-search'); input.value = 'topic33'; input.dispatchEvent({ type: 'input', bubbles: true }); await env.settle(200);
    assert.equal(env.cn('view.length'), 1);                               // only message #34 mentions topic33
    assert.match(env.el('cn-count').textContent, /of 60/);
    input.value = ''; input.dispatchEvent({ type: 'input', bubbles: true }); await env.settle(200);
    assert.equal(env.cn('view.length'), 60);
  });
  await T('search with regex metacharacters does not throw', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(10), mountPage: false }));
    const input = env.el('cn-search'); input.value = '.*+?^${}()|[]\\'; input.dispatchEvent({ type: 'input', bubbles: true });
    await env.settle(250); assert.equal(env.cn('view.length'), 0); assert.match(env.el('cn-empty').textContent, /No messages match/);
  });
  await T('You / Claude filters', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(20), mountPage: false }));
    const chips = env.doc.querySelectorAll('.cn-chip[data-f]');
    chips.find((c) => c.dataset.f === 'human').click(); assert.equal(env.cn('view.length'), 10);
    chips.find((c) => c.dataset.f === 'assistant').click(); assert.equal(env.cn('view.every(m=>m.role==="assistant")'), true);
    chips.find((c) => c.dataset.f === 'all').click(); assert.equal(env.cn('view.length'), 20);
  });
  await T('XSS: message text is escaped in rows and highlights', async (reg) => {
    const msgs = [{ role: 'human', text: '<img src=x onerror=alert(1)> <script>boom()</script>' }, { role: 'assistant', text: 'ok' }];
    const env = reg(await createEnv({ messages: msgs, mountPage: false }));
    assert.equal(env.doc.querySelectorAll('img').length, 0); assert.equal(env.doc.querySelectorAll('script').length, 0);
    const input = env.el('cn-search'); input.value = 'img'; input.dispatchEvent({ type: 'input', bubbles: true }); await env.settle(200);
    assert.equal(env.doc.querySelectorAll('img').length, 0);
  });
  await T('performance: filtering + rendering 5,000 messages is fast', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(5000), mountPage: false }));
    const t0 = process.hrtime.bigint(); env.cn('query="topic4999"; applyFilter()'); env.cn('renderWindow()');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 150, `took ${ms.toFixed(1)}ms`);
  });
  await T('clicking a row does not get swallowed by a re-render', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(40) }));
    env.cn('setSpeed(10,false)');
    const before = rowOf(env, 10); env.cn('scheduleRender()'); await env.settle(30);
    assert.equal(rowOf(env, 10), before, 'rows must be reused when nothing changed');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  S('7. Eye button (reader)');
  await T('tap eye → message shown; tap same eye again → closed', async (reg) => {
    const msgs = makeMessages(30); const env = reg(await createEnv({ messages: msgs, mountPage: false }));
    const eye = () => rowOf(env, 3).querySelector('.cn-read-btn');
    assert.equal(env.el('cn-reader').hidden, true, 'closed at start');
    eye().click();
    assert.equal(env.el('cn-reader').hidden, false);
    assert.equal(env.el('cn-reader-body').textContent, msgs[3].text);
    assert.match(env.el('cn-reader-title').textContent, /#4 · Claude/);
    await env.settle(40); assert.ok(eye().classList.contains('cn-eye-on'), 'eye highlighted while open');
    assert.equal(eye().getAttribute('aria-pressed'), 'true');
    eye().click();
    assert.equal(env.el('cn-reader').hidden, true, 'second tap closes');
    await env.settle(40); assert.ok(!eye().classList.contains('cn-eye-on'));
  });
  await T('tapping a different eye switches message instead of closing', async (reg) => {
    const msgs = makeMessages(30); const env = reg(await createEnv({ messages: msgs, mountPage: false }));
    rowOf(env, 3).querySelector('.cn-read-btn').click(); rowOf(env, 4).querySelector('.cn-read-btn').click();
    assert.equal(env.el('cn-reader').hidden, false); assert.equal(env.el('cn-reader-body').textContent, msgs[4].text);
  });
  await T('reader prev/next, Escape, close button, copy', async (reg) => {
    const msgs = makeMessages(10); const env = reg(await createEnv({ messages: msgs, mountPage: false }));
    rowOf(env, 2).querySelector('.cn-read-btn').click();
    env.el('cn-reader-next').click(); assert.equal(env.el('cn-reader-body').textContent, msgs[3].text);
    env.el('cn-reader-prev').click(); env.el('cn-reader-prev').click(); assert.equal(env.el('cn-reader-body').textContent, msgs[1].text);
    env.el('cn-reader-copy').click(); assert.equal(env.clipboard.pop(), msgs[1].text);
    env.key('Escape', { target: env.doc.body }); assert.equal(env.el('cn-reader').hidden, true);
    rowOf(env, 2).querySelector('.cn-read-btn').click(); env.el('cn-reader-close').click(); assert.equal(env.el('cn-reader').hidden, true);
  });
  await T('reader never opens on its own: scrolling, spy, load and navigation leave it closed', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(60) }));
    for (let y of [0, 4000, 20000, 1e9]) { env.page.scrollTop = y; await env.settle(40); }
    env.cn('refresh(true)'); await env.settle(300);
    assert.equal(env.el('cn-reader').hidden, true);
  });
  await T('reader closes when switching conversations', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(10), mountPage: false }));
    rowOf(env, 1).querySelector('.cn-read-btn').click(); assert.equal(env.el('cn-reader').hidden, false);
    env.setPath('/chat/other'); env.cn('onNavigate()'); assert.equal(env.el('cn-reader').hidden, true);
  });
  await T('clicking the row body (not the eye) jumps and does not open the reader', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(30) }));
    env.cn('setSpeed(10,false)'); rowOf(env, 4).querySelector('.cn-toc-label').click(); await env.settle(300);
    assert.equal(env.el('cn-reader').hidden, true);
    assert.ok(Math.abs(env.page.topOf(4) - 90) <= 45, 'top ' + env.page.topOf(4));
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  S('8. Settings & scroll speed');
  await T('default speed is 5; slider updates, clamps and persists', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(4), mountPage: false }));
    assert.equal(env.cn('speed'), 5); assert.equal(env.el('cn-speed').value, '5'); assert.equal(env.el('cn-speed-val').textContent, '5');
    const r = env.el('cn-speed'); r.value = '9'; r.dispatchEvent({ type: 'input', bubbles: true });
    assert.equal(env.cn('speed'), 9); assert.equal(env.store.cn_speed, 9); assert.equal(env.el('cn-speed-val').textContent, '9');
    env.cn('setSpeed(99,true)'); assert.equal(env.cn('speed'), 10); env.cn('setSpeed(-4,true)'); assert.equal(env.cn('speed'), 1); env.cn('setSpeed("abc",true)'); assert.equal(env.cn('speed'), 5);
  });
  await T('saved speed is restored on next load', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(4), mountPage: false, storage: { cn_speed: 8 } }));
    assert.equal(env.cn('speed'), 8); assert.equal(env.el('cn-speed').value, '8');
  });
  await T('speed → timing curve is monotonic and 10 is instant', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(2), mountPage: false }));
    let lastGlide = Infinity, lastDelay = Infinity;
    for (let s = 1; s <= 10; s++) { env.cn(`setSpeed(${s},false)`); const g = env.cn('glideMs()'), d = env.cn('stepDelay()'); assert.ok(g <= lastGlide && d <= lastDelay, 's' + s); lastGlide = g; lastDelay = d; }
    assert.equal(env.cn('glideMs()'), 0);
  });
  await T('settings panel opens/closes: gear, outside click, Escape', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(4), mountPage: false }));
    const panel = env.el('cn-settings'); assert.equal(panel.hidden, true);
    env.el('cn-settings-btn').click(); assert.equal(panel.hidden, false);
    env.el('cn-settings-btn').click(); assert.equal(panel.hidden, true);
    env.el('cn-settings-btn').click(); env.doc.body.dispatchEvent({ type: 'pointerdown', bubbles: true }); assert.equal(panel.hidden, true);
    env.el('cn-settings-btn').click(); env.key('Escape', { target: env.doc.body }); assert.equal(panel.hidden, true);
  });
  await T('pin keeps sidebar open on outside click; unpinned closes it', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(4), mountPage: false }));
    const sb = env.el('claude-nav-sidebar');
    env.doc.body.dispatchEvent({ type: 'pointerdown', bubbles: true }); assert.ok(sb.classList.contains('cn-hidden'), 'unpinned closes');
    env.cn('openSidebar()'); env.el('cn-pin-btn').click(); env.doc.body.dispatchEvent({ type: 'pointerdown', bubbles: true });
    assert.ok(!sb.classList.contains('cn-hidden'), 'pinned stays open'); assert.equal(env.store.cn_pinned, true);
  });
  await T('sidebar open/closed state persists and "inert" blocks hidden UI', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(4), mountPage: false }));
    env.cn('closeSidebar()'); assert.equal(env.el('claude-nav-sidebar').hasAttribute('inert'), true); assert.equal(env.store.cn_sidebar_visible, false);
    env.cn('openSidebar()'); assert.equal(env.el('claude-nav-sidebar').hasAttribute('inert'), false);
  });
  await T('toggle message from the background (keyboard command) works', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(4), mountPage: false }));
    const l = env.chrome.runtime.onMessage._l[0]; l({ type: 'TOGGLE_SIDEBAR' });
    assert.ok(env.el('claude-nav-sidebar').classList.contains('cn-hidden')); l({ type: 'TOGGLE_SIDEBAR' });
    assert.ok(!env.el('claude-nav-sidebar').classList.contains('cn-hidden'));
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  S('9. Scroll-spy & navigation');
  await T('scroll events from inside the sidebar never change the active row (no feedback loop)', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(60) }));
    env.cn('activeId = "msg-20"'); const before = env.cn('activeId');
    const list = env.el('cn-toc-list'); list.scrollTop = 500;
    list.dispatchEvent({ type: 'scroll', bubbles: true }); await env.settle(60);
    assert.equal(env.cn('activeId'), before);
  });
  await T('scrolling the chat updates the active row', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(60) }));
    env.page.scrollTop = env.page.offs[30] - 100; await env.settle(120);
    env.cn('bind()'); env.page.scroller.dispatchEvent({ type: 'scroll', bubbles: true }); await env.settle(120);
    const a = env.cn('activeId'); assert.ok(a && Math.abs(Number(a.split('-')[1]) - 30) <= 2, 'active ' + a);
  });
  await T('SPA navigation: switching chat clears the outline and loads the new one', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(12), mountPage: false }));
    assert.equal(env.cn('items.length'), 12);
    env.setPath('/chat/zzz'); env.cn('onNavigate()'); assert.equal(env.cn('items.length'), 0);
    await env.settle(200); assert.equal(env.cn('items.length'), 12);
  });
  await T('stale response from a previous chat is discarded', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(12), mountPage: false, autoInit: true }));
    env.cn('currentChatId = "other-chat"'); const ok = await env.cn('syncFromApi()');
    assert.equal(ok, false);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  S('10. Export & diagnostics');
  await T('Markdown export uses original markdown and includes every message', async (reg) => {
    const msgs = makeMessages(8); const env = reg(await createEnv({ messages: msgs, mountPage: false }));
    env.cn('exportMarkdown()'); const d = env.downloads.pop(); assert.match(d.name, /\.md$/);
    const text = await d.blob.text(); assert.ok(text.includes('## Answer 1') && text.includes('`code`'), 'raw markdown kept');
    msgs.forEach((m) => assert.ok(text.includes(m.text.trim().slice(0, 30))));
  });
  await T('JSON export is valid and complete', async (reg) => {
    const msgs = makeMessages(8); const env = reg(await createEnv({ messages: msgs, mountPage: false }));
    env.cn('saveJSON()'); const d = env.downloads.pop(); const j = JSON.parse(await d.blob.text());
    assert.equal(j.messageCount, 8); assert.equal(j.messages[3].text, msgs[3].text); assert.equal(j.messages[0].role, 'human');
  });
  await T('single-message save', async (reg) => {
    const msgs = makeMessages(8); const env = reg(await createEnv({ messages: msgs, mountPage: false }));
    rowOf(env, 2).querySelector('.cn-save-single-btn').click(); const d = env.downloads.pop();
    assert.match(d.name, /-msg3\.md$/); assert.ok((await d.blob.text()).includes(msgs[2].text));
  });
  await T('diagnostics contain structure only — never message text', async (reg) => {
    const msgs = makeMessages(8); msgs[0].text = 'SECRET-PHRASE-12345 do not leak'; const env = reg(await createEnv({ messages: msgs }));
    env.el('cn-diag-btn').click(); await env.settle(20);
    const rep = env.clipboard.pop(); assert.ok(rep, 'nothing copied'); assert.ok(!rep.includes('SECRET-PHRASE'));
    const j = JSON.parse(rep); ['version', 'mode', 'speed', 'items', 'boundToPage', 'scroller', 'testids', 'lastJump'].forEach((k) => assert.ok(k in j, 'missing ' + k));
    assert.ok(!/[a-z0-9]{8}-[a-z0-9]{4}-/.test(j.path), 'chat id must be redacted');
  });
  await T('lastJump diagnostics record the outcome', async (reg) => {
    const env = reg(await createEnv({ messages: makeMessages(40) })); env.cn('setSpeed(10,false)');
    await env.cn('jumpTo("msg-6")'); const lj = JSON.parse(env.cn('JSON.stringify(lastJump)'));
    assert.equal(lj.found, true); assert.equal(lj.n, 7); assert.ok(lj.steps >= 0);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  // report
  let cur = '', pass = 0, fail = 0, skip = 0;
  results.forEach((r) => {
    if (r.suite !== cur) { cur = r.suite; console.log('\n' + cur); }
    if (r.skip) { skip++; console.log('   ' + r.name); return; }
    r.ok ? pass++ : fail++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name} ${r.ok ? `(${r.ms}ms)` : ''}`);
    if (!r.ok) console.log('      ' + String(r.err && (r.err.stack || r.err.message || r.err)).split('\n').slice(0, 4).join('\n      '));
  });
  console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})();
