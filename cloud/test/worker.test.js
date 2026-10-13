// The sync Worker in the real Workers runtime (#90): D1, the Live Durable Object's
// hibernating WebSockets and eviction, the compaction cron — what test/sync.test.mjs and
// test/live.test.mjs (Node, fakes) cannot show.
import { env, SELF, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { compact } from "../src/server.js";

const auth = { authorization: "Bearer test-token" };
/** A push, its body read: workerd keeps an unread response's connection, and the next request waits on it. */
async function push(device, changes) {
  const res = await SELF.fetch("https://sync.test/v1/push", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ device, changes }) });
  await res.text();
  return res;
}
const change = (key, value, at) => ({ entity: "record", key, field: "title", value, at });

describe("sync Worker", () => {
  it("pushes and pulls through D1; a device does not get its own changes back", async () => {
    expect((await push("a", [change("r1", '"one"', 1)])).status).toBe(200);
    const res = await SELF.fetch("https://sync.test/v1/pull?since=0&device=b", { headers: auth });
    const body = await res.json();
    expect(body.changes.map((c) => c.value)).toContain('"one"');
    const own = await (await SELF.fetch("https://sync.test/v1/pull?since=0&device=a", { headers: auth })).json();
    expect(own.changes.filter((c) => c.device === "a")).toHaveLength(0);
  });

  it("refuses a wrong token", async () => {
    const res = await SELF.fetch("https://sync.test/v1/pull?since=0&device=b", { headers: { authorization: "Bearer nope" } });
    await res.text();
    expect(res.status).toBe(401);
  });

  it("tells a live WebSocket after a push, also after the Live object was evicted (hibernation)", async () => {
    const res = await SELF.fetch("https://sync.test/v1/live", { headers: { ...auth, upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    ws.accept();
    const seen = [];
    ws.addEventListener("message", (e) => {
      seen.push(JSON.parse(e.data));
    });
    const until = async (n) => {
      for (let i = 0; i < 100 && seen.length < n; i++) await new Promise((r) => setTimeout(r, 20));
      return seen[n - 1];
    };
    await push("a", [change("r2", '"two"', 2)]);
    expect(await until(1)).toMatchObject({ t: "sync", device: "a" });
    // The object may leave memory between messages; its sockets stay (hibernation).
    await evictDurableObject(env.LIVE.get(env.LIVE.idFromName("default")));
    await push("b", [change("r3", '"three"', 3)]);
    expect(await until(2)).toMatchObject({ t: "sync", device: "b" });
    ws.close(1000, "done");
  });

  it("compaction keeps each field's winning value only", async () => {
    await push("a", [change("r9", '"old"', 10), change("r9", '"new"', 20)]);
    await push("b", [change("r9", '"tie-b"', 20)]);
    expect(await compact(env)).toBeGreaterThan(0);
    const { results } = await env.DB.prepare("SELECT device, value FROM changes WHERE key = 'r9'").all();
    expect(results).toEqual([{ device: "b", value: '"tie-b"' }]);
  });
});
