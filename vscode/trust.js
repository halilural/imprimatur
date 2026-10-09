// @ts-check
// Workspace Trust (#65): in an untrusted folder the extension starts no model
// call (claude), gh or repo script itself. The hooks run outside VS Code and
// decide for themselves (process.js trust); this only guards extension code.
"use strict";

/**
 * A guard for work an untrusted folder must not start: true when trusted, else
 * false and one log line per kind of work (not one per call).
 * @param {() => boolean} isTrusted @param {(msg: string) => void} log
 * @returns {(what: string) => boolean}
 */
function trustGate(isTrusted, log) {
  const said = new Set();
  return (what) => {
    if (isTrusted()) return true;
    if (!said.has(what)) {
      said.add(what);
      log(`untrusted workspace: ${what} skipped (trust the folder to allow it)`);
    }
    return false;
  };
}

module.exports = { trustGate };
