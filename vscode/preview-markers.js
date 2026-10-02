// Runs inside the Markdown preview (markdown.previewScripts). Draws a bar on
// the right edge with one colored tick per agent change; click a tick to jump
// there. Redrawn whenever the preview content updates. The bar sits just left
// of the preview's own scrollbar so it does not cover it.
(function () {
  "use strict";
  const KINDS = [
    ["agent-review-added", "rgb(46, 160, 67)"],
    ["agent-review-changed", "rgb(31, 111, 235)"],
    ["agent-review-old", "rgb(248, 81, 73)"],
  ];

  function draw() {
    let bar = document.getElementById("agent-review-markers");
    const marks = document.querySelectorAll(".agent-review-added, .agent-review-changed, .agent-review-old");
    if (!marks.length) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "agent-review-markers";
      bar.style.cssText = "position:fixed;top:0;right:10px;bottom:0;width:12px;z-index:1000;pointer-events:none;";
      document.body.appendChild(bar);
    }
    bar.textContent = "";
    const total = Math.max(document.documentElement.scrollHeight, 1);
    for (const el of marks) {
      const kind = KINDS.find(([cls]) => el.classList.contains(cls));
      if (!kind) continue;
      const rect = el.getBoundingClientRect();
      const top = ((rect.top + window.scrollY) / total) * 100;
      const height = Math.max((rect.height / total) * 100, 0.4);
      const tick = document.createElement("div");
      const earlier = el.classList.contains("agent-review-earlier");
      tick.title = earlier ? "Earlier agent edit" : "Latest agent edit";
      tick.style.cssText =
        `position:absolute;right:1px;width:10px;top:${top}%;height:${height}%;min-height:3px;` +
        `background:${kind[1]};opacity:${earlier ? 0.5 : 1};border-radius:2px;cursor:pointer;pointer-events:auto;`;
      tick.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation(); // the preview would otherwise jump the editor to this line
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      bar.appendChild(tick);
    }
  }

  let timer;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(draw, 50);
  };
  window.addEventListener("vscode.markdown.updateContent", later);
  window.addEventListener("resize", later);
  window.addEventListener("load", later);
  if (document.readyState !== "loading") later();
  else document.addEventListener("DOMContentLoaded", later);
})();
