# Dock glass

Puts [Glisse](https://github.com/0kzh/glisse)'s Liquid Glass under Dock's translucent bars (the bottom tabs, and
the chat header and composer). Glisse is a React library and Dock has no React and no build step, so this folder
builds a small island: one self-contained ES module that finds the bars, adds a pane to each and mounts Glisse's
`Glass` there. The site itself stays plain files.

Rebuild (the output is committed, so this is only needed after changing `src/` or the versions):

    cd deploy/dock/glass
    npm install
    npm run build

It writes two files into `../www/`:

- `glass.js`: React, ReactDOM and Glisse inlined and minified, no external requests. `index.html` loads it after
  `app.js`. If it is missing or throws, the bars keep the blur that `style.css` gives them.
- `glisse.css`: a copy of `node_modules/glisse/dist/styles.css`. Glisse injects the same CSS from script, which
  Dock's `style-src 'self'` blocks (one console line on load, harmless), so the page links this file instead.

How it works: `src/main.js` watches `#app` and gives every bar a `div.glass-mount` (`display: contents`) with a
`Glass` pane inside; when app.js replaces a page the old roots are unmounted and the new bars get panes. The rules
in `style.css` (`:has(> .glass-mount > .lg-glass)`) take the bar's own background and `backdrop-filter` away once a
pane exists, because a backdrop filter on an ancestor would cut the pane off from the page behind it. Chromium
bends the live page at the rim; Safari and Firefox keep the blur and the rim light.

Versions (pinned exactly, all at least 14 days old when added; `overrides` holds two transitive packages back
because their latest releases were younger): react 19.2.8, react-dom 19.2.8, glisse 0.4.3, vite 8.3.5.
