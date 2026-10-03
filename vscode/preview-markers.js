// Runs inside the Markdown preview (markdown.previewScripts). Draws a bar on
// the right edge with one colored tick per agent change; click a tick to jump
// there. Redrawn whenever the preview content updates. Thin ticks over the
// scrollbar, like the editor's overview ruler; only the ticks take clicks, so
// the scrollbar still works around them.
(function () {
  "use strict";
  const KINDS = [
    ["imprimatur-added", "rgb(46, 160, 67)"],
    ["imprimatur-changed", "rgb(31, 111, 235)"],
    ["imprimatur-old", "rgb(248, 81, 73)"],
    ["imprimatur-diagram", "rgb(210, 153, 34)"],
  ];

  function draw() {
    let bar = document.getElementById("imprimatur-markers");
    const marks = document.querySelectorAll(".imprimatur-added, .imprimatur-changed, .imprimatur-old, .imprimatur-diagram");
    if (!marks.length) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "imprimatur-markers";
      bar.style.cssText = "position:fixed;top:0;right:0;bottom:0;width:10px;z-index:1000;pointer-events:none;";
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
      tick.title = "Agent change";
      tick.style.cssText =
        `position:absolute;right:2px;width:6px;top:${top}%;height:${height}%;min-height:2px;` +
        `background:${kind[1]};opacity:0.9;cursor:pointer;pointer-events:auto;`;
      tick.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation(); // the preview would otherwise jump the editor to this line
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      bar.appendChild(tick);
    }
  }

  // Accept and agent edits refresh the preview, which reloads it at the top.
  // Remember where the reader was; on a reload within 5 s, go back there.
  const KEY = "imprimatur.scroll";
  const store = (() => {
    try {
      return window.sessionStorage;
    } catch {
      return undefined;
    }
  })();
  let saveTimer;
  window.addEventListener("scroll", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        store?.setItem(KEY, JSON.stringify({ y: window.scrollY, t: Date.now() }));
      } catch {}
    }, 100);
  });
  const MARKS = ["imprimatur-added", "imprimatur-changed", "imprimatur-latest", "imprimatur-earlier"];
  /**
   * Clear the accepted block right here, at once: the old-text boxes after the
   * button and the marks on the block (or a table's rows). The file text does
   * not change on accept, so every other button stays right and no reload is
   * needed. Returns false when the preview must be re-rendered (a diagram).
   */
  function clearAccepted(a) {
    if (a.closest?.(".imprimatur-diagram") || !String(a.getAttribute?.("href") ?? "").includes("ui=1")) return false;
    // Everything this button stands for carries its data-ar, wherever the preview put it.
    const id = a.getAttribute?.("data-ar");
    const tagged = id ? [...document.querySelectorAll(`[data-ar="${id}"]`)].filter((el) => el !== a) : [];
    for (const el of tagged)
      if (el.classList.contains("imprimatur-old")) el.remove();
      else el.classList.remove(...MARKS);
    let el = a.nextElementSibling;
    while (el && el.classList?.contains("imprimatur-old")) {
      const next = el.nextElementSibling;
      el.remove();
      el = next;
    }
    if (el?.tagName === "TABLE") el.querySelectorAll("tr").forEach((tr) => tr.classList.remove(...MARKS));
    else if (el && MARKS.some((c) => el.classList?.contains(c))) el.classList.remove(...MARKS);
    // Hide now, remove later: the link must still open (its click goes to the extension).
    a.style.visibility = "hidden";
    setTimeout(() => a.remove(), 500);
    return true;
  }

  // Clicking ✓ Accept: clear the block now and move on to the next change. For a
  // diagram, remember where it was, so the reload can go to the next change.
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target?.closest?.("a.imprimatur-accept");
      if (!a) return;
      const y = a.getBoundingClientRect().top + window.scrollY;
      if (clearAccepted(a)) {
        draw();
        const next = [...document.querySelectorAll(".imprimatur-added, .imprimatur-changed, .imprimatur-old, .imprimatur-diagram")].find(
          (el) => el.getBoundingClientRect().top + window.scrollY >= y - 5,
        );
        if (typeof next?.scrollIntoView === "function") next.scrollIntoView({ block: "center", behavior: "smooth" });
        return; // the link still goes to the extension, which writes the copy
      }
      try {
        store?.setItem(KEY, JSON.stringify({ y: window.scrollY, next: y, t: Date.now() }));
      } catch {}
    },
    true,
  );

  const MARKED = ".imprimatur-added, .imprimatur-changed, .imprimatur-old, .imprimatur-diagram";
  function restore() {
    let saved;
    try {
      saved = JSON.parse(store?.getItem(KEY) ?? "null");
    } catch {}
    if (!saved || Date.now() - saved.t > 5000) return; // first open: leave the preview's own sync alone
    // The preview scrolls to the editor line after loading; land after it.
    const go = () => {
      if (saved.next !== undefined) {
        // After an Accept: the first change at or below the accepted one.
        const target = [...document.querySelectorAll(MARKED)].find((el) => el.getBoundingClientRect().top + window.scrollY >= saved.next - 5);
        if (target) return target.scrollIntoView({ block: "center" });
      }
      window.scrollTo(0, saved.y);
    };
    for (const ms of [0, 150, 400]) setTimeout(go, ms);
  }

  let timer;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(draw, 50);
  };
  window.addEventListener("vscode.markdown.updateContent", later);
  window.addEventListener("resize", later);
  window.addEventListener("load", later);
  if (document.readyState !== "loading") {
    restore();
    later();
  } else
    document.addEventListener("DOMContentLoaded", () => {
      restore();
      later();
    });
})();
