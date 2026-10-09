#!/usr/bin/env node
// npm run test:integration (#68): builds the extension, then runs @vscode/test-cli
// (.vscode-test.mjs). On Linux it runs under xvfb-run when that is installed, so
// it works without a display (CI, WSL, ssh); IMPRIMATUR_IT_XVFB=0 turns that off.
// Extra arguments go to vscode-test (e.g. --grep graph).
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, stdio: "inherit" }).status ?? 1;

let code = run(process.execPath, [path.join(root, "scripts", "build.mjs")]);
if (code) process.exit(code);

const cli = path.join(root, "node_modules", "@vscode", "test-cli", "out", "bin.mjs");
const args = [cli, ...process.argv.slice(2)];
const xvfb = process.platform === "linux" && process.env.IMPRIMATUR_IT_XVFB !== "0" && spawnSync("xvfb-run", ["--help"], { stdio: "ignore" }).status === 0;
code = xvfb ? run("xvfb-run", ["-a", process.execPath, ...args]) : run(process.execPath, args);
process.exit(code);
