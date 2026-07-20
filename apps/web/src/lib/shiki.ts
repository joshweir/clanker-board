import { createJavaScriptRegexEngine } from 'react-shiki/web';

// One shared JS-regex highlighting engine for every code block. Shiki's default
// is the Oniguruma WASM engine, which would need Vite wasm-asset wiring and ships
// a wasm payload; the pure-JS regex engine avoids both and is plenty for the
// languages that appear in ticket bodies. Grammars still load lazily per language
// (Vite code-splits the web bundle's dynamic imports), so only languages actually
// used are fetched.
export const shikiEngine = createJavaScriptRegexEngine();
