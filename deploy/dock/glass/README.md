# Dock glass

Puts [Glisse](https://github.com/0kzh/glisse)'s Liquid Glass into Dock. Glisse is a React library and Dock has no
React and no build step, so this folder builds a small island: one self-contained ES module that takes over a few
plain controls once it has mounted. The site itself stays plain files.

Rebuild (the output is committed, so this is only needed after changing `src/` or the versions):

    cd deploy/dock/glass
    npm install
    npm run build

It writes two files into `../www/`:

- `glass.js`: React, ReactDOM and Glisse inlined and minified, no external requests. `index.html` loads it after
  `app.js`.
- `glisse.css`: a copy of `node_modules/glisse/dist/styles.css`. Glisse injects the same CSS from script, which
  Dock's `style-src 'self'` blocks (one console line on load, harmless), so the page links this file instead.

What it takes over (`src/main.js`, watching `#app` with one MutationObserver, no polling):

- the bottom nav: one floating Glisse `TabBar` for every page, built from the plain `nav.tabs` that app.js renders
  (same links, icons, labels, unread badge; the active tab follows `aria-current`). The plain nav is only made
  invisible, so it still holds the space the chat composer sits on, and a tab tap is handed to its link.
- the range pickers (`.segmented`): a `TabBar` each, a tap clicks the plain button, so app.js's own handler runs.
- the log switch (`label.switch`): a Glisse `Switch`; the hidden checkbox stays the source of truth.
- the chat header and composer: a `Glass` pane in each (rim light, and the lens on a phone).

The plain controls are always rendered first and are the fallback: if `glass.js` or `glisse.css` is missing, or
anything throws at run time, they are shown again and the app works as before. Blur and tint of the nav pill and
the chat bars come from `::before` in `style.css`, not from Glisse's lens filter, so they hold even if the lens
filter is dropped; a lens over a whole desktop-width bar bends nothing visible, so it is left off from 900 px.
`style.css` gives Glisse's tokens Dock's colours and holds the tint and blur in `--glass-tint` and `--glass-blur`.

Versions (pinned exactly, all at least 14 days old when added; `overrides` holds two transitive packages back
because their latest releases were younger): react 19.2.8, react-dom 19.2.8, glisse 0.4.3, vite 8.3.5.
