// ```mermaid blocks in the document tabs (#72): markdown.js leaves them as escaped source in
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
const dv = req("../vscode/markdown.js");
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
