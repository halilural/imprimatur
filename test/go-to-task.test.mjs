import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { taskRows, issueUrl } = createRequire(import.meta.url)("../vscode/go-to-task.js");

test("go to task (#160): this window's repo first, open before done, the key in the label; the issue's URL", () => {
  const repos = [
    { id: 1, name: "imprimatur", root: "/p/imprimatur" },
    { id: 5, name: "dirtywork", root: "/p/dirtywork" },
  ];
  const tasks = {
    1: [{ key: "#160", title: "Go to Task", status: "active", updated_at: 3 }],
    5: [
      { key: "#818", title: "Hint fixes", status: "done", updated_at: 9 },
      { key: "#817", title: "Hint log", status: "active", updated_at: 5 },
      { key: "TEST", title: "Manual tests", status: "open", updated_at: 1 },
    ],
  };
  const rows = taskRows(repos, (id) => tasks[id], ["/p/dirtywork"]);
  assert.deepEqual(rows.map((r) => r.key), ["#817", "TEST", "#818", "#160"]);
  assert.equal(rows[0].label, "#817  Hint log");
  assert.equal(rows[0].root, "/p/dirtywork");
  assert.equal(rows[0].issue, "817");
  assert.equal(rows[1].issue, null);
  assert.equal(issueUrl("git@github.com:halilural/dirtywork.git\n", "817"), "https://github.com/halilural/dirtywork/issues/817");
  assert.equal(issueUrl("https://github.com/halilural/imprimatur", "160"), "https://github.com/halilural/imprimatur/issues/160");
  assert.equal(issueUrl("https://gitlab.com/a/b.git", "1"), null);
});
