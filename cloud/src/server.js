// Imprimatur sync server (#61): a Cloudflare Worker over one D1 table, `changes`.
// The Worker's entry is worker.js (workerd takes only handlers and classes as its exports).
// Each device pushes its field changes and pulls everyone else's in order (seq);
// merging (last writer wins per field) happens on the devices, not here.
//   POST /v1/push  {device, changes: [{entity, key, field, value, at}]}  → {last}
//   GET  /v1/pull?since=<seq>&device=<id>&limit=1000                   → {changes, last, more}
//   GET  /v1/live   WebSocket (#71) to the `Live` Durable Object: {"t":"sync","seq":N,"device":"…"}
//                   after each push, {"t":"tracker","repo":"owner/name"} after a GitHub issue changed
//   POST /v1/github GitHub's `issues` webhook (#71), signed with GITHUB_WEBHOOK_SECRET; no Bearer
// Auth: Authorization: Bearer <SYNC_TOKEN> (a Worker secret), compared in constant time.
// Limits (#89): RATE_LIMITER (a Workers rate-limit binding, per client IP) answers 429 with
// Retry-After; a D1 write that fails transiently is retried with backoff; D1 overloaded or
// over its quota answers 503 with Retry-After. A daily cron (scheduled → compact) deletes
// change rows a newer one of the same field supersedes, by the devices' own rule.
// handle() needs only D1's prepare/bind/all/run/batch and a Durable Object stub's fetch, so tests
// run it in Node over node:sqlite; Live takes its runtime pieces (WebSocketPair, the 101) as deps.

export const MAX_CHANGES = 1000;
export const MAX_BODY = 1_000_000;
export const MAX_VALUE = 100_000;
export const MAX_KEY = 2000;
const ENTITIES = ["repo", "task", "record", "section"];
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

/**
 * The body as text, or a Response when too large or unreadable. The limit holds while the
 * stream is read (a missing or false content-length does not get past it).
 * @param {Request} req @param {number} [max] @returns {Promise<string | Response>}
 */
export async function bodyText(req, max = MAX_BODY) {
  const tooBig = () => fail(413, `body over ${max} bytes; push fewer changes at once`);
  if (Number(req.headers.get("content-length") ?? 0) > max) return tooBig();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        reader.cancel().catch(() => {});
        return tooBig();
      }
      parts.push(value);
    }
  } catch {
    return fail(400, "body could not be read");
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** D1's transient errors (developers.cloudflare.com/d1/best-practices/retry-queries/). @param {unknown} e */
export const retryable = (e) => /Network connection lost|storage caused object to be reset|reset because its code was updated/.test(String(e?.message ?? e));
/** D1 asking for less load: overloaded, or a quota spent. @param {unknown} e */
export const overloaded = (e) => /overloaded|Too many requests|exceeded|quota|limit reached/i.test(String(e?.message ?? e));

/**
 * Runs fn, again on a transient D1 error: up to `tries` times, exponential backoff with
 * jitter. A push repeated after a commit only writes the same field values twice, which
 * the devices' last-writer-wins merge ignores.
 * @template T @param {() => Promise<T>} fn @param {{tries?: number, baseMs?: number, sleep?: (ms: number) => Promise<void>}} [o] @returns {Promise<T>}
 */
export async function withRetry(fn, { tries = 4, baseMs = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries || !retryable(e)) throw e;
      await sleep(baseMs * 2 ** (attempt - 1) * (0.5 + Math.random()));
    }
  }
}

/** The account's one Live object (#71), or undefined before it is deployed. @param {any} env */
const liveStub = (env) => env.LIVE?.get(env.LIVE.idFromName("default"));

/**
 * Tells every live connection (#71). Never fails the request that caused it.
 * @param {any} env @param {object} msg @param {{waitUntil?: (p: Promise<any>) => void}} [ctx]
 */
function notify(env, msg, ctx) {
  const stub = liveStub(env);
  if (!stub) return;
  const p = Promise.resolve()
    .then(() => stub.fetch("https://live.internal/notify", { method: "POST", body: JSON.stringify(msg) }))
    .catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(p);
  return p;
}

/** @param {Request} req @param {{DB: any}} env @param {any} [ctx] */
async function push(req, env, ctx) {
  const text = await bodyText(req);
  if (text instanceof Response) return text;
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
  const [, last] = await withRetry(() => env.DB.batch([
    env.DB.prepare(`INSERT INTO changes (device, entity, key, field, value, at)
                    SELECT ?, json_extract(j.value, '$.entity'), json_extract(j.value, '$.key'), json_extract(j.value, '$.field'),
                           json_extract(j.value, '$.value'), json_extract(j.value, '$.at')
                    FROM json_each(?) j ORDER BY CAST(j.key AS INTEGER)`).bind(body.device, rows),
    env.DB.prepare("SELECT max(seq) AS last FROM changes"),
  ]));
  const seq = last.results[0]?.last ?? 0;
  // Other devices pull now instead of at their next poll.
  const told = notify(env, { t: "sync", seq, device: body.device }, ctx);
  if (!ctx?.waitUntil) await told;
  return reply(200, { last: seq });
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

/** Hex of HMAC-SHA256(secret, text). @param {string} secret @param {string} text */
export async function hmacHex(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `issues` actions that can change a task's status or title; the rest are ignored. */
export const ISSUE_ACTIONS = ["opened", "closed", "reopened", "edited"];

/**
 * GitHub's webhook (#71): X-Hub-Signature-256 over the raw body with GITHUB_WEBHOOK_SECRET
 * (no secret set: nobody gets in), then live connections hear which repo changed.
 * @param {Request} req @param {any} env @param {any} [ctx]
 */
async function github(req, env, ctx) {
  // Refused before the body is read: no secret, no signature, not JSON.
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  if (!env.GITHUB_WEBHOOK_SECRET || !/^sha256=[0-9a-f]{64}$/.test(sig)) return fail(401, "bad signature");
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return fail(415, "content type must be application/json");
  const text = await bodyText(req);
  if (text instanceof Response) return text;
  if (!(await same(sig, `sha256=${await hmacHex(env.GITHUB_WEBHOOK_SECRET, text)}`))) return fail(401, "bad signature");
  const event = req.headers.get("x-github-event") ?? "";
  if (event === "ping") return reply(200, { ok: true });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "body must be JSON");
  }
  const repo = body?.repository?.full_name;
  if (event !== "issues" || !ISSUE_ACTIONS.includes(body?.action) || typeof repo !== "string") return reply(200, { ignored: true });
  // A delivery seen before (GitHub's redelivery, or a replay) is ignored: the Live object keeps
  // the last REPLAY_KEEP delivery ids and body digests. Answered after it decided.
  const stub = liveStub(env);
  if (!stub) return reply(200, { ok: true });
  const delivery = (req.headers.get("x-github-delivery") ?? "").slice(0, 100);
  const digest = await hmacHex("imprimatur-delivery", text);
  let out;
  try {
    const res = await stub.fetch("https://live.internal/notify", { method: "POST", body: JSON.stringify({ msg: { t: "tracker", repo }, delivery, digest }) });
    out = await res.json();
  } catch {
    return reply(200, { ok: true });
  }
  return reply(200, out?.duplicate ? { ignored: "duplicate" } : { ok: true });
}

/**
 * Deletes change rows that a newer row of the same field supersedes, by the devices' rule
 * (db.js applyField: the later `at` wins, then the greater device id): no device would
 * apply them, and a device that has not pulled yet still gets the winning value. In
 * chunks (D1 caps a query's work); at most `rounds` a run.
 * @param {{DB: any}} env @param {{chunk?: number, rounds?: number}} [o] @returns {Promise<number>} rows deleted
 */
export async function compact(env, { chunk = 5000, rounds = 20 } = {}) {
  let deleted = 0;
  for (let i = 0; i < rounds; i++) {
    const r = await withRetry(() => env.DB.prepare(`DELETE FROM changes WHERE seq IN (
        SELECT c.seq FROM changes c WHERE EXISTS (
          SELECT 1 FROM changes n WHERE n.entity = c.entity AND n.key = c.key AND n.field = c.field
            AND (n.at > c.at OR (n.at = c.at AND (n.device > c.device OR (n.device = c.device AND n.seq > c.seq)))))
        LIMIT ?)`).bind(chunk).run());
    const n = Number(r?.meta?.changes ?? r?.changes ?? 0);
    deleted += n;
    if (n < chunk) break;
  }
  return deleted;
}

/** Requests a client IP may make a minute (wrangler.jsonc RATE_LIMITER; a first sync pages fast). */
export const RATE_PER_MINUTE = 300;

/** Deliveries remembered against replays (#71). */
export const REPLAY_KEEP = 500;

/** @param {Request} req @param {{DB: any, SYNC_TOKEN?: string, LIVE?: any, GITHUB_WEBHOOK_SECRET?: string, RATE_LIMITER?: any}} env @param {any} [ctx] */
export async function handle(req, env, ctx) {
  const url = new URL(req.url);
  // Per client IP, before any work (a token guess costs a request too). No binding: no limit.
  if (env.RATE_LIMITER) {
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key: `ip:${ip}` });
    if (!success) return withHeader(fail(429, "too many requests; slow down"), "retry-after", "60");
  }
  try {
    // Signed by GitHub, not by our token.
    if (req.method === "POST" && url.pathname === "/v1/github") return await github(req, env, ctx);
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : String(e));
  }
  if (!(await authorized(req, env))) return fail(401, "unauthorized");
  try {
    if (req.method === "POST" && url.pathname === "/v1/push") return await push(req, env, ctx);
    if (req.method === "GET" && url.pathname === "/v1/pull") return await pull(url, env);
    if (req.method === "GET" && url.pathname === "/v1/live") {
      if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return fail(426, "expected a WebSocket upgrade");
      const stub = liveStub(env);
      if (!stub) return fail(501, "live updates are not deployed (the LIVE Durable Object binding is missing)");
      // Only upgrades reach the object: its /notify is for this Worker alone.
      return await stub.fetch(req);
    }
  } catch (e) {
    // D1 overloaded or out of quota: the client backs off (vscode/sync.js) instead of hammering.
    if (overloaded(e)) return withHeader(fail(503, `database busy: ${e instanceof Error ? e.message : e}`), "retry-after", "300");
    return fail(500, e instanceof Error ? e.message : String(e));
  }
  return fail(404, "not found");
}

/** @param {Response} res @param {string} k @param {string} v */
function withHeader(res, k, v) {
  res.headers.set(k, v);
  return res;
}

/**
 * One per account (idFromName("default")), #71: holds every device's WebSocket with the
 * Hibernation API, so it sleeps (and costs nothing) between messages. "ping" is answered
 * "pong" by the runtime without waking it. POST /notify (from handle only) sends a JSON
 * message to every socket. Keeps nothing in storage.
 */
export class Live {
  /**
   * @param {any} ctx DurableObjectState @param {any} env
   * @param {{pair?: () => [any, any], upgraded?: (client: any) => Response, autoResponse?: () => any}} [deps] for tests
   */
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx;
    this.env = env;
    this.pair = deps.pair ?? (() => /** @type {[any, any]} */ (Object.values(new WebSocketPair())));
    this.upgraded = deps.upgraded ?? ((client) => new Response(null, { status: 101, webSocket: client }));
    const auto = deps.autoResponse ?? (() => new WebSocketRequestResponsePair("ping", "pong"));
    ctx.setWebSocketAutoResponse?.(auto());
  }

  /** @param {Request} req */
  async fetch(req) {
    const url = new URL(req.url);
    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const [client, server] = this.pair();
      this.ctx.acceptWebSocket(server);
      return this.upgraded(client);
    }
    if (req.method === "POST" && url.pathname === "/notify") {
      let msg;
      try {
        msg = await req.json();
      } catch {
        return fail(400, "body must be JSON");
      }
      // A GitHub delivery: {msg, delivery, digest}; seen before → not sent again.
      if (msg && typeof msg === "object" && "msg" in msg) {
        if (await this.seen(msg.delivery, msg.digest)) return reply(200, { duplicate: true, sent: 0 });
        msg = msg.msg;
      }
      return reply(200, { sent: this.broadcast(JSON.stringify(msg)) });
    }
    return fail(404, "not found");
  }

  /**
   * Whether this delivery id or body digest came before; remembers it (the last REPLAY_KEEP)
   * in the object's storage. The object runs one request at a time: no race between two.
   * @param {unknown} delivery @param {unknown} digest
   */
  async seen(delivery, digest) {
    const keys = [delivery, digest].filter((k) => typeof k === "string" && k).map((k) => String(k));
    if (!keys.length) return false;
    /** @type {string[]} */
    const list = (await this.ctx.storage.get("deliveries")) ?? [];
    if (keys.some((k) => list.includes(k))) return true;
    list.push(...keys);
    await this.ctx.storage.put("deliveries", list.slice(-REPLAY_KEEP * 2));
    return false;
  }

  /** Sends text to every connected socket; a dead one is skipped. @param {string} text @returns {number} sockets reached */
  broadcast(text) {
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
        n++;
      } catch {}
    }
    return n;
  }

  /** Clients send nothing but "ping" (answered by the runtime): anything else is ignored. */
  webSocketMessage() {}

  /** @param {any} ws @param {number} code @param {string} reason */
  webSocketClose(ws, code, reason) {
    // The runtime answers the Close frame itself (compatibility date ≥ 2026-04-07); this is for older dates.
    try {
      ws.close(code, reason);
    } catch {}
  }

  /** @param {any} ws */
  webSocketError(ws) {
    try {
      ws.close(1011, "error");
    } catch {}
  }
}

