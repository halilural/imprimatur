import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { issueMatches } = createRequire(import.meta.url)("../vscode/issue-match.js");

test("issue search (#154): digits match the number, exact first; words match the title; only GitHub issues", () => {
  const tasks = [
    { key: "#1400", title: "Later", status: "open" },
    { key: "#140", title: "feat(setup): know when a plugin is out of date", status: "active" },
    { key: "#14", title: "Old", status: "done" },
    { key: "PROJ-140", title: "Jira one", status: "open" },
  ];
  assert.deepEqual(issueMatches(tasks, "140").map((t) => t.key), ["#140", "#1400"]);
  assert.deepEqual(issueMatches(tasks, "#14").map((t) => t.key), ["#14", "#140", "#1400"]);
  assert.deepEqual(issueMatches(tasks, "Plugin date").map((t) => t.key), ["#140"]);
  assert.deepEqual(issueMatches(tasks, "  "), []);
});
