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
