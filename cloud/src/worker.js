// Imprimatur sync server (#61): a Cloudflare Worker over one D1 table, `changes`.
// Each device pushes its field changes and pulls everyone else's in order (seq);
// merging (last writer wins per field) happens on the devices, not here.
//   POST /v1/push  {device, changes: [{entity, key, field, value, at}]}  → {last}
//   GET  /v1/pull?since=<seq>&device=<id>&limit=1000                   → {changes, last, more}
// Auth: Authorization: Bearer <SYNC_TOKEN> (a Worker secret), compared in constant time.
// handle() needs only D1's prepare/bind/all/run/batch, so tests run it in Node over node:sqlite.

export const MAX_CHANGES = 1000;
export const MAX_BODY = 1_000_000;
const MAX_VALUE = 100_000;
const MAX_KEY = 2000;
const ENTITIES = ["repo", "task", "record"];
const ID = /^[A-Za-z0-9._:-]{1,100}$/;

const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, error) => reply(status, { error });

/** Equal strings, in time that does not depend on where they differ: compares SHA-256 digests. */
async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

/** @param {Request} req @param {{SYNC_TOKEN?: string}} env */
async function authorized(req, env) {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  // No secret set: nobody gets in.
  return Boolean(env.SYNC_TOKEN && m && (await same(m[1], env.SYNC_TOKEN)));
}

/** The reason a pushed change is refused, or undefined. @param {any} c */
function invalid(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "change must be an object";
  if (!ENTITIES.includes(c.entity)) return `entity must be one of ${ENTITIES.join(", ")}`;
  if (typeof c.key !== "string" || !c.key || c.key.length > MAX_KEY) return `key must be a string of 1..${MAX_KEY} chars`;
  if (typeof c.field !== "string" || !/^[a-z_]{1,40}$/.test(c.field)) return "field must be a short lower-case name";
  if (c.value !== null && (typeof c.value !== "string" || c.value.length > MAX_VALUE)) return `value must be null or a string of at most ${MAX_VALUE} chars`;
  if (!Number.isSafeInteger(c.at) || c.at <= 0) return "at must be a positive integer (epoch ms)";
  return undefined;
}

/** @param {Request} req @param {{DB: any}} env */
async function push(req, env) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return fail(413, `body over ${MAX_BODY} bytes; push fewer changes at once`);
  const text = await req.text();
  if (text.length > MAX_BODY) return fail(413, `body over ${MAX_BODY} bytes; push fewer changes at once`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "body must be JSON");
  }
  if (typeof body?.device !== "string" || !ID.test(body.device)) return fail(400, "device must be an id (1..100 of A-Z a-z 0-9 . _ : -)");
  if (!Array.isArray(body.changes)) return fail(400, "changes must be an array");
  if (body.changes.length > MAX_CHANGES) return fail(413, `at most ${MAX_CHANGES} changes per push`);
  for (let i = 0; i < body.changes.length; i++) {
    const why = invalid(body.changes[i]);
    if (why) return fail(400, `changes[${i}]: ${why}`);
  }
  if (!body.changes.length) {
    const row = await env.DB.prepare("SELECT coalesce(max(seq), 0) AS last FROM changes").first();
    return reply(200, { last: row?.last ?? 0 });
  }
  const rows = JSON.stringify(body.changes.map(({ entity, key, field, value, at }) => ({ entity, key, field, value, at })));
  // One statement for the whole batch (D1 caps bound parameters and queries per request).
  const [, last] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO changes (device, entity, key, field, value, at)
                    SELECT ?, json_extract(j.value, '$.entity'), json_extract(j.value, '$.key'), json_extract(j.value, '$.field'),
                           json_extract(j.value, '$.value'), json_extract(j.value, '$.at')
                    FROM json_each(?) j ORDER BY CAST(j.key AS INTEGER)`).bind(body.device, rows),
    env.DB.prepare("SELECT max(seq) AS last FROM changes"),
  ]);
  return reply(200, { last: last.results[0]?.last ?? 0 });
}

/** @param {URL} url @param {{DB: any}} env */
async function pull(url, env) {
  const since = Number(url.searchParams.get("since") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? MAX_CHANGES);
  const device = url.searchParams.get("device") ?? "";
  if (!Number.isSafeInteger(since) || since < 0) return fail(400, "since must be a sequence number (0 or more)");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHANGES) return fail(400, `limit must be 1..${MAX_CHANGES}`);
  if (!ID.test(device)) return fail(400, "device must be an id");
  // The caller's own changes are read past (so `last` moves on) but not sent back.
  const { results } = await env.DB.prepare("SELECT seq, device, entity, key, field, value, at FROM changes WHERE seq > ? ORDER BY seq LIMIT ?")
    .bind(since, limit).all();
  return reply(200, {
    changes: results.filter((r) => r.device !== device),
    last: results.length ? results[results.length - 1].seq : since,
    more: results.length === limit,
  });
}

/** @param {Request} req @param {{DB: any, SYNC_TOKEN?: string}} env */
export async function handle(req, env) {
  const url = new URL(req.url);
  if (!(await authorized(req, env))) return fail(401, "unauthorized");
  try {
    if (req.method === "POST" && url.pathname === "/v1/push") return await push(req, env);
    if (req.method === "GET" && url.pathname === "/v1/pull") return await pull(url, env);
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : String(e));
  }
  return fail(404, "not found");
}

export default { fetch: handle };
