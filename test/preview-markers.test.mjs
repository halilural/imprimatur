import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

// A minimal DOM, enough for the marker script: three marked blocks in a 1000px page.
function fakeDom(blocks) {
  const created = [];
  const listeners = {};
  const mk = (tag) => {
    const el = { tag, style: {}, children: [], textContent: "", id: "", title: "", handlers: {} };
    el.appendChild = (c) => el.children.push(c);
    el.remove = () => (el.removed = true);
    el.addEventListener = (n, f) => (el.handlers[n] = f);
    created.push(el);
    return el;
  };
  const body = mk("body");
  const els = blocks.map(([cls, top, height]) => ({
    classList: { contains: (c) => cls.split(" ").includes(c) },
    getBoundingClientRect: () => ({ top, height }),
    scrollIntoView: function () { this.scrolled = true; },
  }));
  const document = {
    readyState: "complete",
    listeners: {},
    body,
    documentElement: { scrollHeight: 1000 },
    getElementById: (id) => created.find((e) => e.id === id),
    createElement: mk,
    querySelectorAll: () => els,
    addEventListener(n, f) {
      this.listeners[n] = f;
    },
  };
  const storage = {};
  const window = {
    scrollY: 0,
    addEventListener: (n, f) => (listeners[n] = f),
    scrollTo: (_x, y) => (window.scrollY = y),
    sessionStorage: { getItem: (k) => storage[k] ?? null, setItem: (k, v) => (storage[k] = v) },
  };
  return { document, window, body, els, listeners, storage };
}

test("preview marker bar: one tick per marked block, colored by kind, click scrolls", async () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../vscode/preview-markers.js"), "utf8");
  const dom = fakeDom([
    ["imprimatur-added imprimatur-latest", 100, 50],
    ["imprimatur-old imprimatur-earlier", 500, 20],
    ["imprimatur-changed imprimatur-latest", 900, 10],
  ]);
  vm.runInNewContext(src, { ...dom, setTimeout: (f) => f(), clearTimeout() {} });
  const bar = dom.body.children[0];
  assert.equal(bar.id, "imprimatur-markers");
  assert.equal(bar.children.length, 3);
  assert.match(bar.children[0].style.cssText, /top:10%;.*rgb\(46, 160, 67\);opacity:0.9/);
  assert.match(bar.children[1].style.cssText, /top:50%;.*rgb\(248, 81, 73\);opacity:0.9/);
  bar.children[2].handlers.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(dom.els[2].scrolled, true);
});

test("preview scroll: a reload right after a scroll goes back there; a first open does not", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../vscode/preview-markers.js"), "utf8");
  const ctx = (dom) => ({ ...dom, setTimeout: (f) => f(), clearTimeout() {} });
  const first = fakeDom([["imprimatur-added imprimatur-latest", 100, 50]]);
  vm.runInNewContext(src, ctx(first));
  assert.equal(first.window.scrollY, 0); // nothing saved: stays where the preview put it
  first.window.scrollY = 700;
  first.listeners.scroll();
  // the refresh reloads the page: same storage, scroll back at the top
  const reload = fakeDom([["imprimatur-added imprimatur-latest", 100, 50]]);
  Object.assign(reload.storage, first.storage);
  vm.runInNewContext(src, ctx(reload));
  assert.equal(reload.window.scrollY, 700);
});

test("after an accept, the reload goes to the next change below it", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../vscode/preview-markers.js"), "utf8");
  const ctx = (dom) => ({ ...dom, setTimeout: (f) => f(), clearTimeout() {} });
  const before = fakeDom([["imprimatur-old imprimatur-latest", 300, 20], ["imprimatur-changed imprimatur-latest", 600, 20]]);
  vm.runInNewContext(src, ctx(before));
  const link = { closest: () => link, getBoundingClientRect: () => ({ top: 300 }) };
  before.document.listeners.click({ target: link }); // ✓ Accept on the block at 300
  // reloaded: the accepted block is gone, the next one is at 600
  const after = fakeDom([["imprimatur-changed imprimatur-latest", 600, 20]]);
  Object.assign(after.storage, before.storage);
  vm.runInNewContext(src, ctx(after));
  assert.equal(after.els[0].scrolled, true);
});

test("accept in the preview clears the block at once, no reload, and moves to the next change", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../vscode/preview-markers.js"), "utf8");
  const cls = (names) => {
    const set = new Set(names);
    return { contains: (c) => set.has(c), remove: (...cs) => cs.forEach((c) => set.delete(c)), has: (c) => set.has(c) };
  };
  const block = { classList: cls(["imprimatur-changed", "imprimatur-latest"]), getBoundingClientRect: () => ({ top: 300, height: 20 }) };
  const old = { classList: cls(["imprimatur-old"]), getBoundingClientRect: () => ({ top: 280, height: 20 }) };
  const next = { classList: cls(["imprimatur-added"]), getBoundingClientRect: () => ({ top: 600, height: 20 }), scrollIntoView() { this.scrolled = true; } };
  const link = {
    getAttribute: (n) => (n === "href" ? "vscode://x/accept?start=1&end=2&ui=1" : null),
    getBoundingClientRect: () => ({ top: 270 }),
    closest: (sel) => (sel === "a.imprimatur-accept" ? link : null),
    nextElementSibling: old,
    style: {},
    remove() { this.removed = true; },
  };
  old.nextElementSibling = block;
  old.remove = () => (old.removed = true);
  const dom = fakeDom([]);
  const live = () => [old, block, next].filter((e) => !e.removed && [...["imprimatur-added", "imprimatur-changed", "imprimatur-old"]].some((c) => e.classList.contains(c)));
  dom.document.querySelectorAll = () => live();
  vm.runInNewContext(src, { ...dom, setTimeout: (f) => f(), clearTimeout() {} });
  dom.document.listeners.click({ target: link });
  assert.equal(old.removed, true);
  assert.equal(block.classList.has("imprimatur-changed"), false);
  assert.equal(link.removed, true);
  assert.equal(next.scrolled, true);
  assert.equal(dom.storage["imprimatur.scroll"], undefined); // no reload expected, nothing saved for one
});

test("accept clears its block by data-ar even when something sits between box and block", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "../vscode/preview-markers.js"), "utf8");
  const cls = (names) => {
    const set = new Set(names);
    return { contains: (c) => set.has(c), remove: (...cs) => cs.forEach((c) => set.delete(c)), has: (c) => set.has(c) };
  };
  const box = { classList: cls(["imprimatur-old"]), remove() { this.removed = true; }, getBoundingClientRect: () => ({ top: 280 }) };
  const block = { classList: cls(["imprimatur-changed", "imprimatur-latest"]), getBoundingClientRect: () => ({ top: 300 }) };
  const other = { classList: cls(["imprimatur-changed"]), getBoundingClientRect: () => ({ top: 600 }), scrollIntoView() {} };
  const link = {
    getAttribute: (n) => ({ href: "vscode://x/accept?ui=1", "data-ar": "5-6" })[n] ?? null,
    getBoundingClientRect: () => ({ top: 270 }),
    closest: (sel) => (sel === "a.imprimatur-accept" ? link : null),
    nextElementSibling: { classList: cls([]) }, // e.g. a wrapper the preview added
    style: {},
    remove() {},
  };
  const dom = fakeDom([]);
  dom.document.querySelectorAll = (sel) => (sel === '[data-ar="5-6"]' ? [link, box, block] : [box, block, other].filter((e) => !e.removed));
  vm.runInNewContext(src, { ...dom, setTimeout: (f) => f(), clearTimeout() {} });
  dom.document.listeners.click({ target: link });
  assert.equal(box.removed, true);
  assert.equal(block.classList.has("imprimatur-changed"), false);
  assert.equal(other.classList.has("imprimatur-changed"), true);
});
