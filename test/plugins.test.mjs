// Plugins (#106): config.json's "plugins" loaded by openDb; each write reported to onChange in its
// transaction; adoptRepo and onOrigin around a repo's origin; a broken plugin never breaks a write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { openDb, FIELDS } = require("../vscode/db.js");

/** A folder with a plugin file that records what it is told in globalThis[tag]. @param {string} tag @param {string} [extra] */
function pluginDir(tag, extra = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-plugin-"));
  const file = path.join(dir, `${tag}.js`);
  fs.writeFileSync(file, `
const seen = (globalThis[${JSON.stringify(tag)}] ??= []);
module.exports = {
  name: ${JSON.stringify(tag)},
  setup(db, lib) { seen.push(["setup", typeof lib.openDb, Boolean(lib.FIELDS)]); },
  onChange(db, entity, target, fields, at) { seen.push([entity, typeof target === "object" ? target.id : target, fields, typeof at]); },
  ${extra}
};`);
  return { dir, file };
}

test("plugins: config.json next to the database names them; setup gets db.js's exports", () => {
  const { dir, file } = pluginDir("p1");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ plugins: [file] }));
  const db = openDb({ path: path.join(dir, "i.db") });
  try {
    assert.deepEqual(db.plugins.map((p) => p.name), ["p1"]);
    assert.deepEqual(globalThis.p1[0], ["setup", "function", true]);
  } finally {
    db.close();
  }
});

test("plugins: every write is reported with the changed fields, in its transaction", () => {
  const { dir, file } = pluginDir("p2");
  const db = openDb({ path: path.join(dir, "i.db"), plugins: [file] });
  try {
    const repo = db.repoOf("/w/proj", { origin: "https://github.com/u/proj" });
    db.upsertTask(repo.id, "#1", { title: "T" });
    db.upsertTask(repo.id, "#1", { title: "T" });
    db.upsertTask(repo.id, "#1", { status: "active" });
    const seen = globalThis.p2.slice(1);
    assert.deepEqual(seen[0], ["repo", repo.id, FIELDS.repo, "number"]);
    assert.deepEqual(seen[1][0], "task");
    assert.ok(seen[1][2].includes("title"));
    // The same title again changes nothing: nothing reported.
    assert.deepEqual(seen.slice(2).map((s) => [s[0], s[2]]), [["task", ["status"]]]);
  } finally {
    db.close();
  }
});

test("plugins: one that throws is logged; the write stays", () => {
  const { dir, file } = pluginDir("p3", 'onChange() { throw new Error("boom"); },');
  const db = openDb({ path: path.join(dir, "i.db"), plugins: [file] });
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    const repo = db.repoOf("/w/proj");
    db.upsertTask(repo.id, "#1", { title: "kept" });
    assert.equal(db.taskByKey(repo.id, "#1").title, "kept");
    assert.ok(errors.some((e) => /p3: boom/.test(e)));
  } finally {
    console.error = orig;
    db.close();
  }
});

test("plugins: a path that does not load is logged once and left out", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-plugin-"));
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    const db = openDb({ path: path.join(dir, "i.db"), plugins: [path.join(dir, "missing.js")] });
    assert.equal(db.plugins.length, 0);
    db.close();
    assert.equal(errors.length, 1);
  } finally {
    console.error = orig;
  }
});

test("plugins: adoptRepo hands a new root an existing row; onOrigin hears a learnt origin", () => {
  const { dir, file } = pluginDir("p4", `
  adoptRepo(db, origin) { return origin === "github.com/u/kept" ? db.q("SELECT * FROM repos WHERE root = 'held'").get() : undefined; },
  onOrigin(db, repo) { seen.push(["origin", repo.origin]); },`);
  const db = openDb({ path: path.join(dir, "i.db"), plugins: [file] });
  try {
    db.q("INSERT INTO repos (uid, root, origin, name, created_at) VALUES ('u1', 'held', 'github.com/u/kept', 'kept', 1)").run();
    const held = db.q("SELECT id FROM repos WHERE root = 'held'").get().id;
    assert.equal(db.repoOf("/w/kept", { origin: "git@github.com:u/kept.git" }).id, held);
    db.repoOf("/w/other");
    db.repoOf("/w/other", { origin: "https://github.com/u/other" });
    assert.deepEqual(globalThis.p4.filter((s) => s[0] === "origin"), [["origin", "https://github.com/u/other"]]);
  } finally {
    db.close();
  }
});

test("plugins: an in-memory database loads none from config", () => {
  assert.deepEqual(openDb({ path: ":memory:" }).plugins, []);
});

test("plugins: a hook that throws midway leaves none of its own writes; the user's write stays", () => {
  const { dir, file } = pluginDir("p5", `
  setup(db) { db.sqlite.exec("CREATE TABLE IF NOT EXISTS p5 (x)"); },
  onChange(db) { db.q("INSERT INTO p5 VALUES (1)").run(); throw new Error("half"); },`);
  const db = openDb({ path: path.join(dir, "i.db"), plugins: [file] });
  const orig = console.error;
  console.error = () => {};
  try {
    const repo = db.repoOf("/w/proj");
    db.upsertTask(repo.id, "#1", { title: "kept" });
    assert.equal(db.taskByKey(repo.id, "#1").title, "kept");
    assert.equal(db.q("SELECT count(*) AS n FROM p5").get().n, 0);
  } finally {
    console.error = orig;
    db.close();
  }
});

test("plugins: onOrigin or adoptRepo that throws does not break repoOf", () => {
  const { dir, file } = pluginDir("p6", `
  adoptRepo() { throw new Error("adopt"); },
  onOrigin() { throw new Error("origin"); },`);
  const db = openDb({ path: path.join(dir, "i.db"), plugins: [file] });
  const orig = console.error;
  console.error = () => {};
  try {
    assert.ok(db.repoOf("/w/a", { origin: "https://github.com/u/a" }).id);
    db.repoOf("/w/b");
    assert.equal(db.repoOf("/w/b", { origin: "https://github.com/u/b" }).origin, "https://github.com/u/b");
  } finally {
    console.error = orig;
    db.close();
  }
});

test("plugins: one that does not load leaves meta plugin:missed:<path>, kept from the first time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-plugin-"));
  const missing = path.join(dir, "missing.js");
  const orig = console.error;
  console.error = () => {};
  try {
    const a = openDb({ path: path.join(dir, "i.db"), plugins: [missing] });
    const first = a.meta(`plugin:missed:${missing}`);
    a.close();
    assert.ok(Number(first) > 0);
    const b = openDb({ path: path.join(dir, "i.db"), plugins: [missing] });
    assert.equal(b.meta(`plugin:missed:${missing}`), first);
    b.close();
  } finally {
    console.error = orig;
  }
});

test("plugins: an exercise's weak points are reported once they are saved, recall cards first", () => {
  const { dir, file } = pluginDir("p7");
  // The plugin reads the recall cards in onChange: they are already there.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("seen.push([entity,", "if (entity === 'exercise') seen.push(['reviews', db.q('SELECT prompt FROM exercise_reviews WHERE exercise_id = ? ORDER BY id').all(target).map((r) => r.prompt)]);\n    seen.push([entity,"));
  const db = openDb({ path: path.join(dir, "i.db"), plugins: [file] });
  try {
    const e = db.saveExercise({ topic: "Bedrock", steps: [{ title: "Call it" }] });
    db.saveExercise({ id: e.id, steps: [{ id: e.steps[0].id, note: "ok" }] });
    assert.deepEqual(globalThis.p7.slice(1), [], "no weak points: nothing to tell");
    db.saveExercise({ id: e.id, weak: ["line", { front: "Which error never leaves the client?", back: "ParamValidationError", deck: "Cloud GenAI" }] });
    assert.deepEqual(globalThis.p7.slice(1), [
      ["reviews", ["line", "Which error never leaves the client?"]],
      ["exercise", e.id, ["weak"], "number"],
    ]);
  } finally {
    db.close();
  }
});
