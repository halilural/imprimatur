// ```mermaid blocks in the document tabs (#72): docsView leaves them as escaped source in
// a .mermaid-src block; the panel page loads the extension's mermaid and draws an <svg>.
// The second test opens the real page in headless Chromium (skipped when none is found).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const dv = req("../vscode/docsView.js");
const MERMAID = path.resolve(import.meta.dirname, "../node_modules/mermaid/dist/mermaid.min.js");

test("#72 a mermaid fence becomes a .mermaid-src block with its escaped source and a key", () => {
  const src = "graph TD\n  A[\"<b>x</b>\"] --> B\n";
  const out = dv.renderMarkdown(`Text\n\n\`\`\`mermaid\n${src}\`\`\`\n\n\`\`\`js\nlet a = 1 < 2;\n\`\`\`\n`);
  const m = out.match(/<div class="mermaid-src" data-key="([0-9a-f]{16})"><pre>([\s\S]*?)<\/pre><\/div>/);
  assert.ok(m, out);
  assert.equal(m[1], dv.mermaidKey(src));
  assert.equal(m[2], "graph TD\n  A[&quot;&lt;b&gt;x&lt;/b&gt;&quot;] --&gt; B\n");
  assert.ok(!out.includes("<b>"), "no raw HTML from the diagram");
  assert.match(out, /<pre><code class="language-js">let a = 1 &lt; 2;/, "other fences stay code");
  // "mermaid" is the info's first word, in any case; anything else stays code.
  assert.match(dv.renderMarkdown("```Mermaid title\ngraph LR\n```"), /class="mermaid-src"/);
  assert.doesNotMatch(dv.renderMarkdown("```mermaidx\ngraph LR\n```"), /mermaid-src/);
  // Raw HTML stays text (html: false).
  assert.match(dv.renderMarkdown("<script>x</script>"), /&lt;script&gt;/);
  assert.notEqual(dv.mermaidKey("a"), dv.mermaidKey("b"));
});

/** A Chromium to run the page in: IMPRIMATUR_CHROME, else Playwright's headless shell, else one on PATH. */
function chrome() {
  if (process.env.IMPRIMATUR_CHROME) return process.env.IMPRIMATUR_CHROME;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    for (const d of fs.readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of fs.readdirSync(path.join(cache, d))) {
        const bin = path.join(cache, d, sub, "chrome-headless-shell");
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch {}
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    const r = spawnSync("which", [name], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.trim();
  }
  return undefined;
}

const bin = chrome();

test("#72 the panel's document tab draws a mermaid block as an <svg> under its CSP", { skip: !bin && "no Chromium found" }, () => {
  const Module = req("node:module");
  const load = Module._load;
  Module._load = function (r, ...a) {
    return r === "vscode" ? { window: {}, workspace: {}, commands: {}, env: {}, Uri: {} } : load.call(this, r, ...a);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-mermaid-"));
  try {
    const { html } = req("../vscode/graphView.js");
    fs.copyFileSync(MERMAID, path.join(dir, "mermaid.min.js"));
    const src = pathToFileURL(path.join(dir, "mermaid.min.js")).href;
    const section = (id, body) => ({ id, key: `s${id}`, title: `S${id}`, status: "current", n: id, body, html: dv.renderMarkdown(body), contributors: [], versions: [], editing: false, flash: false });
    const model = {
      kind: "architecture", label: "Mimari", title: "Mimari", repoName: "repo", last: undefined, adding: false, empty: false, manual: undefined, superseded: [],
      current: [section(1, "```mermaid\ngraph TD\n  A[Hook] --> B[(DB)]\n```"), section(2, "```mermaid\ngraph TD\n  A --> \n```")],
    };
    const page = html({ rows: [], lanes: [], sessions: [] }, dir, "N", [], { view: { tab: "architecture" }, pane: dv.docHtml(model), repoName: "repo", mermaid: { src, csp: "file:" } });
    assert.ok(page.includes("script-src 'nonce-N' file:;"), "the nonce and the webview's cspSource");
    assert.ok(!/img-src|unsafe-eval/.test(page.match(/Content-Security-Policy" content="([^"]*)"/)[1]));
    // The webview's API, and a probe that reports what the shadow roots hold in the title.
    const stub = `<script nonce="N">window.acquireVsCodeApi = () => ({ postMessage() {}, setState() {}, getState() {} });
const errs = []; document.addEventListener("securitypolicyviolation", (e) => errs.push(e.violatedDirective + " " + e.blockedURI));
setInterval(() => { const d = [...document.querySelectorAll(".mermaid-src")].map((x) => x.shadowRoot ? (x.shadowRoot.querySelector("svg") ? "svg" : x.shadowRoot.querySelector(".err") ? "err" : "?") : "-");
document.title = "R:" + d.join(",") + "|CSP:" + errs.join(";"); }, 50);</script></head>`;
    const file = path.join(dir, "page.html");
    fs.writeFileSync(file, page.replace("</head>", stub));
    const r = spawnSync(bin, ["--headless", "--no-sandbox", "--disable-gpu", "--allow-file-access-from-files", "--virtual-time-budget=15000", "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 60000 });
    const title = r.stdout.match(/<title>([^<]*)<\/title>/)?.[1];
    assert.equal(title, "R:svg,err|CSP:", `${title} ${r.stderr.slice(-500)}`);
  } finally {
    Module._load = load;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
