import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseFlowchart, mermaidDiff, mermaidBlocks, matchOld } = createRequire(import.meta.url)("../vscode/mermaid-diff.js");

const OLD = `flowchart LR
  subgraph AWS["AWS"]
    ING[Ingest<br/>device integration]
    MQ[(ActiveMQ)]
    WK[Workers]
    OLDN[Legacy]
  end
  GW -->|HTTPS + mTLS| ING
  ING --> MQ
  MQ --> WK
  WK --> OLDN
  classDef mine fill:#1e7d32
  class ING,WK mine`;

const NEW = `flowchart LR
  subgraph AWS["AWS"]
    ING[Ingest<br/>device integration]
    MQ[(ActiveMQ broker)]
    WK[Workers]
    RD[(Redis)]
  end
  GW -->|HTTPS + mTLS| ING
  ING -->|transmission id| MQ
  MQ --> WK
  WK --> RD
  classDef mine fill:#1e7d32
  class ING,WK mine`;

test("parse: nodes with labels and edges in linkStyle order", () => {
  const f = parseFlowchart(NEW);
  assert.equal(f.nodes.get("MQ"), "ActiveMQ broker");
  assert.equal(f.nodes.has("AWS"), false); // subgraph is not a node
  assert.deepEqual(f.edges.map((e) => `${e.from}>${e.to}|${e.label}`), ["GW>ING|HTTPS + mTLS", "ING>MQ|transmission id", "MQ>WK|", "WK>RD|"]);
  assert.equal(parseFlowchart("sequenceDiagram\n A->>B: hi"), undefined);
});

test("diff: added, changed and removed nodes and edges get colors; removed ones come back dashed", () => {
  const d = mermaidDiff(OLD, NEW);
  const text = d.lines.join("\n");
  assert.match(text, /class RD arAdded/);
  assert.match(text, /class MQ arChanged/); // label ActiveMQ -> ActiveMQ broker
  assert.match(text, /ar_removed_OLDN\["Legacy"\]/);
  assert.match(text, /class ar_removed_OLDN arRemoved/);
  assert.match(text, /linkStyle 1 stroke:#d29922/); // ING-->MQ got a label
  assert.match(text, /linkStyle 3 stroke:#2ea043/); // WK-->RD is new
  assert.match(text, /WK -\.-> ar_removed_OLDN/); // removed edge kept, dashed
  assert.match(text, /linkStyle 4 stroke:#f85149/);
  assert.deepEqual([d.added, d.changed, d.removed], [2, 2, 2]);
});

test("diff: unchanged diagram adds nothing; chained edges count one by one", () => {
  assert.deepEqual(mermaidDiff(OLD, OLD).lines, []);
  assert.deepEqual(parseFlowchart("graph TD\n A --> B --> C").edges.length, 2);
});

test("blocks: find mermaid fences and pair a changed block with its old version", () => {
  const md = "# T\n\n```mermaid\n" + OLD + "\n```\n\ntext\n\n```mermaid\ngraph TD\n X --> Y\n```\n";
  const blocks = mermaidBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(matchOld(blocks, NEW).trim(), OLD.trim());
});
