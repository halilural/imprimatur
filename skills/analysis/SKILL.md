---
name: analysis
description: Write or update a task's analysis in Imprimatur as a short design doc in five chapters (context, goals, design, alternatives, risks), before code is written. It sums up what the conversation and the code already settled. If decisions are still open, it asks them in numbered rounds, each with a recommended answer. It hands fact-finding to a background agent that reads primary sources. New terms go to the glossary, and a hard-to-reverse choice becomes an ADR. Use when the user says /analysis, "analyse this", "analiz", "analiz yaz", "write the analysis", "design doc", "spec this", "plan this task", or before starting a task whose approach is not yet clear.
---

# Analysis

A task's analysis is a **short design doc** in the task's analysis document in Imprimatur. It
has one section per chapter. Write it before writing code. Write it for a reader who comes
back to the task in a month and needs to know why it is built the way it is.

| Chapter key | Holds |
| --- | --- |
| `context` | The problem from the user's side, how things stand now, and the facts found, with sources |
| `goals` | What will be true when this is done: numbered user stories ("As a …, I want …, so that …") and acceptance criteria. Also the non-goals and what is out of scope |
| `design` | The decisions: which modules change, their interfaces, data and schema, contracts, and how it is tested (which seam, prior art) |
| `alternatives` | The options weighed, and why each one lost |
| `risks` | What could go wrong, what is unknown, and the questions still open |

## Steps

1. **Find the task.** It is the one the user names, or the one being worked on (`where_we_left_off`).
   Read what it already has with `doc_get {kind: "analysis", task}`, and its records with
   `task_get`. Update the analysis rather than starting over.
2. **Synthesize first.** Write what the conversation, the records and the code already settle.
   Do not ask about what you can read. Use the repo's glossary terms (`doc_get {kind: "glossary"}`),
   and keep to the ADRs in the area you touch.
3. **Find facts, do not ask for them.** When a chapter needs a fact (an API, a version, how a
   library behaves, what the code does), start a background agent with a fresh context. It reads
   **primary sources** (official docs, source code, specs) and reports each claim with its source.
   Questions that depend on that fact wait for it. Everything else goes ahead.
4. **Ask the open decisions in rounds.** Put each decision that is still the user's to make into
   a numbered round. Ask everything that can be asked now, and nothing that depends on an answer
   from this same round. Word each question so that "yes" accepts your recommendation:

   ```
   ❓ **Q1** - **<title>**: <the question and its choices>

   ➡️ <your recommended answer>
   ```

   Each round's answers open the next round. Stop when nothing is left silently assumed.
5. **Write each chapter** as you settle it, with
   `doc_section_upsert {kind: "analysis", task, key: <chapter key>, chapter: <chapter key>, title, body}`.
   Use the chapter's key as the section's key. Keys with `--` belong to sections read from the
   task's files, and are refused.
   - **Decisions, not code.** Name modules and interfaces instead of pasting code. A file:line
     goes in `context`, as evidence of how things stand now.
   - **Diagrams:** Mermaid. A `sequenceDiagram` gets `autonumber`, and under it a numbered list
     explaining each arrow.
6. **Glossary and decisions.**
   - **Terms:** a term that is new, or that now means something else, goes in the glossary,
     one section per term, as soon as it is settled.
   - **ADRs:** offer one (`record_add {kind: "adr"}` for how it is built, `pdr` for what the user
     gets) only when the choice is hard to reverse, surprising without context, **and** the result
     of a real trade-off. Link it to the architecture or product section it shapes.
7. **Close.** Give the user one line per chapter. Move the task's 👉 to the first open step with
   `pointer_set`, and keep its summary to one line saying where things stand. Do not start the
   build until the user agrees the analysis is right.

## Files the agent writes

Plans, spike results and research notes that the agent writes as `.md` files are read into the
same document automatically. Each `##` heading becomes a section, and its chapter comes from the
heading: "Context", "Goals", "Options", "Risks", and anything else is "design". So headings
named after the chapters land where they belong. Write the analysis itself with the steps above.
