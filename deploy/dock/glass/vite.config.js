import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// One self-contained ES module (React, ReactDOM and Glisse inlined) next to the site's own scripts, plus Glisse's
// stylesheet: the copy it injects at run time is blocked by the page's CSP, so the site links this file instead.
export default defineConfig({
  // lib mode leaves this alone, and React picks its development build without it
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'glisse-css',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'glisse.css', source: readFileSync(here('node_modules/glisse/dist/styles.css')) });
    },
  }],
  build: {
    outDir: here('../www'),
    emptyOutDir: false, // www/ holds the site
    copyPublicDir: false,
    minify: true,
    lib: { entry: here('src/main.js'), formats: ['es'], fileName: () => 'glass.js' },
    // lib mode keeps ES output readable unless asked
    rolldownOptions: { output: { minify: true } },
  },
});
