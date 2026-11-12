// Glisse's Liquid Glass under Dock's translucent bars. Loaded after the app's own scripts; if anything here fails the
// bars keep the blur that style.css gives them (it only steps aside once a pane is really in the bar).
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Glass } from 'glisse';

// the bottom tabs, the chat composer and the chat header (the only sticky one)
const BARS = '.tabs, .chat-compose, .shell.chat > .top';
const roots = new Map(); // bar -> its React root

// inline: Glisse's own `.lg-glass { position: relative }` would win over a rule in style.css
const PANE = { position: 'absolute', inset: 0, zIndex: -1, borderRadius: 'inherit', pointerEvents: 'none' };

function attach(bar, stop) {
  bar.querySelector(':scope > .glass-mount')?.remove(); // a copy of a bar carries a dead pane
  const host = document.createElement('div');
  host.className = 'glass-mount';
  host.style.display = 'contents'; // no box of its own: the pane positions against the bar
  bar.prepend(host);
  const root = createRoot(host, { onUncaughtError: stop, onRecoverableError: () => {} });
  roots.set(bar, root);
  // synchronous, so a page change never paints the bar bare for a frame
  flushSync(() => root.render(createElement(Glass, { 'aria-hidden': true, style: PANE })));
}

function start() {
  const app = document.getElementById('app');
  let observer = null;
  const stop = () => observer?.disconnect();
  const scan = () => {
    try {
      // app.js replaces whole pages, bars included
      for (const [bar, root] of roots) if (!bar.isConnected) { roots.delete(bar); root.unmount(); }
      const bare = [...app.querySelectorAll(BARS)].filter((bar) => !roots.has(bar));
      // --lg-glass comes from glisse.css; without it a pane would be invisible, so leave the bars alone
      if (bare.length && getComputedStyle(document.documentElement).getPropertyValue('--lg-glass')) for (const bar of bare) attach(bar, stop);
    } catch {
      stop();
    }
  };
  observer = new MutationObserver(scan);
  observer.observe(app, { childList: true, subtree: true });
  scan();
}

try {
  start();
} catch {
  // the bars stay as style.css draws them
}
