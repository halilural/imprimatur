// Imprimatur sync server's entry (#61, #71): the Worker's fetch and its `Live` Durable
// Object. workerd takes only handlers and classes as this module's exports, so the code
// and its constants live in server.js (which the Node tests import).
import { handle, compact, Live } from "./server.js";

export { Live };
export default {
  fetch: (req, env, ctx) => handle(req, env, ctx),
  // Daily (wrangler.jsonc triggers): superseded change rows go (#89).
  scheduled: (event, env, ctx) => ctx.waitUntil(compact(env).then((n) => console.log(`compact: ${n} superseded rows deleted`))),
};
