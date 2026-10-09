#!/usr/bin/env node
// After each agent turn (waiting.mjs starts it on Stop, in the background):
// Haiku reviews the session's "Waiting on you" list with the agent's final
// message (vscode/audit.js). If the model fails, the rule-based reading of the
// message (waiting.mjs asksIn: 👉 lines, "?", ask phrases) adds the item instead.
//
//   node audit.mjs <waiting log> <message> [request] [title]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { asksIn } from "./waiting.mjs";

const require = createRequire(import.meta.url);
const { audit } = require("../vscode/audit.js");

/**
 * @param {string} log @param {{message: string, request?: string, title?: string}} turn
 * @param {(prompt: string) => Promise<string>} [ask]
 */
export async function auditTurn(log, turn, ask) {
  const session = path.basename(log, ".jsonl");
  try {
    return await audit(log, { ...turn, session }, ask);
  } catch {
    const { lines, action } = asksIn(turn.message);
    if (!lines.length) return undefined;
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const row = { t: new Date().toISOString(), session, kind: action ? "verify" : "question", text: lines.join("\n") };
    fs.appendFileSync(log, JSON.stringify({ ...row, detail: turn.message.slice(0, 4000), prompt: turn.request, title: turn.title }) + "\n");
    return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [log, message = "", request, title] = process.argv.slice(2);
  auditTurn(log, { message, request: request || undefined, title: title || undefined, lang: require("../vscode/config.js").hookLang() })
    .catch((e) => process.stderr.write(`imprimatur audit: ${e.message}\n`))
    .finally(() => process.exit(0));
}
