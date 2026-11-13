// Glisse's Liquid Glass in Dock. app.js draws plain markup (bottom nav, range pickers, log switch, chat bars); this
// takes it over only once Glisse has mounted, and gives it all back if anything throws.
import { createElement as h, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Glass, Switch, TabBar } from 'glisse';

const PANES = '.chat-row'; // the floating chat field; the bottom nav is a TabBar instead
// inline: Glisse's own `.lg-glass { position: relative }` would win over a rule in style.css
const PANE = { position: 'absolute', inset: 0, zIndex: -1, borderRadius: 'inherit', pointerEvents: 'none' };

const app = document.getElementById('app');
const mounted = new Map(); // plain element -> { root, host, undo }
let nav = null; // the floating bottom nav: one instance for every page, so the lens glides between tabs
let observer = null;
let dead = false; // a render error can land inside draw(): nothing may be hidden after that

/** a copy of the plain tab's icon, badge and label (the badge keeps updating: app.js finds it by [data-unread]) */
function Clone({ nodes }) {
  const ref = useRef(null);
  useLayoutEffect(() => { ref.current.replaceChildren(...nodes.map((n) => n.cloneNode(true))); }, [nodes]);
  return h('span', { ref, className: 'dock-tab', 'data-tab-bounce': '' });
}

/** the lens moves on a tap at once; the page's own handler then re-renders, which brings a fresh bar */
function Seg({ labels, selected, width, name, press }) {
  const [value, setValue] = useState(String(selected));
  const [seen, setSeen] = useState(selected);
  if (seen !== selected) { setSeen(selected); setValue(String(selected)); }
  return h(TabBar, {
    items: labels.map((label, i) => ({ value: String(i), label })), value, 'aria-label': name,
    style: { '--lg-tab-width': `${width}px`, '--lg-tab-height': '34px' },
    onValueChange: (v) => { setValue(v); press(Number(v)); },
  });
}

/** the hidden checkbox stays the source of truth (app.js reads it); a label tap changes it, so listen too */
function Toggle({ input, name }) {
  const [on, setOn] = useState(input.checked);
  useLayoutEffect(() => {
    const sync = () => setOn(input.checked);
    input.addEventListener('change', sync);
    return () => input.removeEventListener('change', sync);
  }, [input]);
  return h(Switch, {
    checked: on, 'aria-label': name,
    onCheckedChange: (v) => { input.checked = v; input.dispatchEvent(new Event('change', { bubbles: true })); },
  });
}

function stop(error) {
  if (dead) return;
  dead = true;
  if (error) console.warn('glass.js stopped, the plain controls are back:', error);
  observer?.disconnect();
  const all = [...mounted.values(), ...(nav ? [nav] : [])];
  mounted.clear();
  nav = null;
  for (const rec of all) rec.undo();
  setTimeout(() => { for (const rec of all) { try { rec.root.unmount(); } catch { /* already gone */ } } }, 0);
}
const root = (host) => createRoot(host, { onUncaughtError: stop, onRecoverableError: () => {} });
// synchronous, so a page change never paints the plain control for a frame
const draw = (rec, element) => flushSync(() => rec.root.render(element));

function pane(bar) {
  bar.querySelector(':scope > .glass-mount')?.remove(); // a copy of a bar carries a dead pane
  const host = document.createElement('div');
  host.className = 'glass-mount';
  host.style.display = 'contents'; // no box of its own: the pane positions against the bar
  bar.prepend(host);
  const rec = { host, root: root(host), undo: () => host.remove() };
  mounted.set(bar, rec);
  draw(rec, h(Glass, { 'aria-hidden': true, style: PANE }));
}

function syncNav(plain) {
  if (!plain) { if (nav) nav.host.hidden = true; return; }
  if (!nav) {
    const host = document.createElement('div');
    host.className = 'dock-nav';
    document.body.append(host);
    nav = { host, root: root(host), plain: null, links: [], value: undefined, items: [], undo: () => { host.remove(); if (nav?.plain) delete nav.plain.dataset.glass; } };
    // the plain link does the work (it scrolls to the top when you are on that page already)
    host.addEventListener('click', (e) => {
      const tab = e.target.closest?.('a.lg-tab');
      if (!tab || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = nav?.links[[...host.querySelectorAll('a.lg-tab')].indexOf(tab)];
      if (link) { e.preventDefault(); link.click(); }
    });
  }
  nav.host.hidden = false;
  const links = [...plain.querySelectorAll(':scope > a')];
  const value = links.find((a) => a.getAttribute('aria-current') === 'page')?.getAttribute('href') ?? null;
  if (nav.plain === plain && nav.value === value) return;
  if (nav.plain !== plain) {
    if (nav.plain) delete nav.plain.dataset.glass;
    nav.plain = plain;
    nav.links = links;
    nav.items = links.map((a) => ({ value: a.getAttribute('href'), href: a.getAttribute('href'), label: h(Clone, { nodes: [...a.childNodes] }) }));
  }
  nav.value = value;
  draw(nav, h(TabBar, { items: nav.items, value, 'aria-label': plain.getAttribute('aria-label') ?? undefined }));
  if (!dead) plain.dataset.glass = ''; // style.css hides the plain bar but keeps its box: the chat composer sits on top of it
}

let canvas = null;
/** one width for every tab, from the longest label in the button's own font */
function tabWidth(labels, sample) {
  canvas ??= document.createElement('canvas').getContext('2d');
  canvas.font = getComputedStyle(sample).font;
  return Math.ceil(Math.max(...labels.map((l) => canvas.measureText(l).width))) + 28;
}

function syncSeg(group, ok) {
  const buttons = [...group.querySelectorAll(':scope > button')];
  if (!buttons.length) return; // the site list fills in once its data arrives
  let rec = mounted.get(group);
  if (!rec) {
    if (!ok()) return;
    const host = document.createElement('div');
    host.className = group.classList.contains('scroll') ? 'glass-seg scroll' : 'glass-seg';
    group.after(host);
    rec = { host, root: root(host), sig: '', buttons, undo: () => { group.hidden = false; host.remove(); } };
    mounted.set(group, rec);
  }
  rec.buttons = buttons;
  const labels = buttons.map((b) => b.textContent.trim());
  const selected = buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
  const sig = `${labels.join('\n')}\0${selected}`;
  if (sig === rec.sig) return;
  rec.sig = sig;
  draw(rec, h(Seg, { labels, selected, width: tabWidth(labels, buttons[0]), name: group.getAttribute('aria-label') ?? undefined, press: (i) => rec.buttons[i]?.click() }));
  if (!dead) group.hidden = true;
}

function syncSwitch(label) {
  const input = label.querySelector(':scope > input[type=checkbox]');
  const name = label.textContent.trim();
  const host = document.createElement('span');
  host.className = 'glass-switch';
  input.after(host);
  const rec = { host, root: root(host), undo: () => { input.hidden = false; host.remove(); } };
  mounted.set(label, rec);
  draw(rec, h(Toggle, { input, name }));
  if (!dead) input.hidden = true;
}

function scan() {
  if (dead) return;
  try {
    for (const [plain, rec] of mounted) if (!plain.isConnected) { mounted.delete(plain); setTimeout(() => rec.root.unmount(), 0); }
    // --lg-glass comes from glisse.css; without it nothing Glisse draws would show, so leave the plain controls alone
    let styled;
    const ok = () => !dead && (styled ??= !!getComputedStyle(document.documentElement).getPropertyValue('--lg-glass'));
    const plainNav = app.querySelector('nav.tabs');
    if (nav || (plainNav && ok())) syncNav(plainNav);
    for (const group of app.querySelectorAll('.segmented')) syncSeg(group, ok);
    for (const label of app.querySelectorAll('label.switch')) if (!mounted.has(label) && label.querySelector(':scope > input[type=checkbox]') && ok()) syncSwitch(label);
    for (const bar of app.querySelectorAll(PANES)) if (!mounted.has(bar) && ok()) pane(bar);
  } catch (error) {
    stop(error);
  }
}

try {
  observer = new MutationObserver(scan);
  observer.observe(app, { childList: true, subtree: true });
  scan();
} catch {
  // the plain controls stay as app.js draws them
}
