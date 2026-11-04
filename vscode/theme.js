// @ts-check
// The panel's design tokens: one orange accent per theme kind (contrast checked: text in it
// reads on the editor background, its ink reads on it), surfaces, lines, elevation, radii,
// spacing and a type scale. Everything else stays the theme's own --vscode-* colours.
"use strict";

const THEME_CSS = `
  body {
    --acc: #fb923c; --acc-ink: #1e1e1e;
    --acc-soft: color-mix(in srgb, var(--acc) 14%, transparent); --acc-line: color-mix(in srgb, var(--acc) 50%, transparent);
    --surface: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); --surface-2: var(--vscode-sideBar-background, var(--surface));
    --line: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
    --muted: var(--vscode-descriptionForeground);
    --shadow: 0 1px 2px rgba(0,0,0,.28), 0 6px 18px -6px var(--vscode-widget-shadow, rgba(0,0,0,.4));
    --r-sm: 4px; --r-md: 8px; --r-lg: 12px; --r-pill: 999px;
    --fs-xs: 11px; --fs-sm: 12px; --fs-body: 13px; --fs-h3: 15px; --fs-h2: 17px; --fs-h1: 22px;
    --pass: var(--vscode-testing-iconPassed, #73c991); --warn: var(--vscode-editorWarning-foreground, #cca700); --info: var(--vscode-charts-blue, #3794ff);
    background: var(--vscode-editor-background);
  }
  /* The board look (#148, after the ponytail board): its palette in place of the editor theme's
     colours, so every tab's cards, lines and text follow it; light themes get its light variant.
     High-contrast themes keep VS Code's own colours. Body text never uses a faint grey. */
  body.vscode-dark, body.vscode-light {
    --b-bg: #070707; --b-panel: #0d0d0c; --b-card: linear-gradient(180deg, #111110, #0a0a09); --b-line: #1f1f1d; --b-line2: #2a2a27;
    --b-text: #f3f2ee; --b-muted: #a3a19a; --b-hover: #171716; --b-input: #0f0f0e;
    --vscode-editor-background: var(--b-bg); --vscode-foreground: var(--b-text); --vscode-descriptionForeground: var(--b-muted);
    --vscode-panel-border: var(--b-line); --vscode-widget-border: var(--b-line2); --vscode-sideBar-background: var(--b-panel);
    --vscode-editorWidget-background: var(--b-panel); --vscode-input-background: var(--b-input); --vscode-input-border: var(--b-line2);
    --vscode-list-hoverBackground: var(--b-hover); --vscode-toolbar-hoverBackground: var(--b-hover); --vscode-textCodeBlock-background: #121211;
    --surface: var(--b-panel); --surface-2: var(--b-bg); --line: var(--b-line); --muted: var(--b-muted);
    --shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 18px 44px -12px rgba(0,0,0,.55);
    --r-md: 10px; --r-lg: 16px;
    --mono: "JetBrains Mono", var(--vscode-editor-font-family), ui-monospace, monospace;
    background: var(--b-bg); color: var(--b-text); font-variant-numeric: tabular-nums;
  }
  body.vscode-light {
    --b-bg: #f5f5f3; --b-panel: #ffffff; --b-card: #ffffff; --b-line: #e6e5e0; --b-line2: #d9d7d0;
    --b-text: #1d1c1a; --b-muted: #5f5d57; --b-hover: #efeeea; --b-input: #ffffff; --vscode-textCodeBlock-background: #f0efeb;
    --shadow: 0 1px 2px rgba(0,0,0,.05), 0 10px 28px -14px rgba(0,0,0,.18);
  }
  /* Cards: the board's gradient and inner highlight. */
  body.vscode-dark :is(.card, .bucket, .etable, .tablewrap), body.vscode-light :is(.card, .bucket, .etable, .tablewrap) { background: var(--b-card); border-color: var(--b-line); }
  body.vscode-dark header.appbar, body.vscode-light header.appbar { background: color-mix(in srgb, var(--b-bg) 88%, transparent); backdrop-filter: blur(8px); }
  body.vscode-light { --acc: #c2410c; --acc-ink: #ffffff; --shadow: 0 1px 2px rgba(0,0,0,.06), 0 6px 16px -8px rgba(0,0,0,.18); }
  body.vscode-high-contrast { --acc: #ffa94d; --acc-ink: #000000; --shadow: none; --line: var(--vscode-contrastBorder, #6fc3df); }
  body.vscode-high-contrast-light { --acc: #9a3412; --acc-ink: #ffffff; --shadow: none; --line: var(--vscode-contrastBorder, #0f4a85); }
  /* The app bar: brand, the tabs, the search and the tab's own actions. */
  header.appbar { position: sticky; top: 0; z-index: 20; margin: 0 -12px; padding: 8px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px;
    background: var(--vscode-editor-background); border-bottom: 1px solid var(--line); }
  /* A narrow panel: the bar wraps to several rows, so it scrolls away instead of covering the page. */
  @media (max-width: 760px) { header.appbar { position: static; } }
  .brand { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-h3); }
  .brand .mascot { flex: none; filter: drop-shadow(0 1px 1px rgba(0,0,0,.25)); }
  .brand strong { font-weight: 800; letter-spacing: -.01em; }
  .brand .repo { padding: 1px 9px; border-radius: var(--r-pill); background: var(--acc-soft); color: var(--acc); font-weight: 700; font-size: var(--fs-sm); }
  nav.tabs { display: flex; flex-wrap: wrap; gap: 1px; }
  nav.tabs button { display: inline-flex; align-items: center; gap: 6px; padding: 6px 9px; border: 0; border-radius: var(--r-md); background: transparent;
    color: var(--vscode-foreground); font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap; }
  nav.tabs button .ic { color: var(--muted); }
  nav.tabs button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  nav.tabs button.on { background: var(--acc-soft); color: var(--acc); box-shadow: inset 0 0 0 1px var(--acc-line); }
  nav.tabs button.on .ic { color: var(--acc); }
  nav.tabs .badge { min-width: 18px; padding: 0 6px; border-radius: var(--r-pill); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    font-size: var(--fs-xs); font-weight: 700; line-height: 18px; text-align: center; }
  nav.tabs button.on .badge { background: var(--acc); color: var(--acc-ink); }
  .tools-r { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .searchbox { display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; height: 30px; box-sizing: border-box; border-radius: var(--r-md);
    border: 1px solid var(--vscode-input-border, var(--line)); background: var(--vscode-input-background); color: var(--muted); }
  .searchbox:focus-within { border-color: var(--vscode-focusBorder); } .searchbox:focus-within input { width: 260px; }
  .searchbox input { width: 150px; max-width: 46vw; transition: width .15s ease; border: 0; outline: none; background: transparent; color: var(--vscode-input-foreground); font: inherit; padding: 0; }
  .tbtn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; box-sizing: border-box; border-radius: var(--r-md); cursor: pointer;
    border: 1px solid var(--line); background: var(--surface); color: var(--vscode-foreground); font: inherit; font-weight: 700; }
  .tbtn:hover { border-color: var(--acc-line); background: var(--acc-soft); } .tbtn .ic { color: var(--acc); }
  .tbtn:focus-visible, nav.tabs button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
`;

module.exports = { THEME_CSS };
