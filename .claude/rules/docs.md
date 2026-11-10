---
paths:
  - "docs/**"
---

# Writing this repo's documents

- Imprimatur's database is the source of these files (Matt Pocock's model): `docs/PROJECT.md` (mission, constraints, tech stack, roadmap), `docs/capabilities/<name>.md` (how one feature behaves now), `docs/adr/NNNN-*.md`, `GLOSSARY.md` at the root and `.out-of-scope/`. Change them with `doc_section_upsert`, an ADR with `record_add`/`record_update`, or in the Imprimatur panel: the next export writes over a hand edit, except an ADR file, which is read back into its record.
- A task's spec goes through Matt Pocock's `to-spec` gates: stories, design, analyze, then tickets. `/to-spec`, `/to-tickets` and `/wayfinder` are started by the user; when you start a task yourself, read the to-spec skill's SKILL.md and write the spec the same way with `doc_section_upsert` (kind `spec`), before the code. Work too big for one session starts with `/wayfinder`. A product choice lives in the spec.
- An ADR (record kind `adr`) is only for a decision that is hard to reverse, surprising without its context, and the result of a real trade-off; it stands alone.
- A spec section that changes a capability carries its delta (added, modified, removed, renamed), keyed `<capability>--<requirement>`; it merges into the capability when the task is done.
- A new term, or a term that changes meaning, goes in the glossary, one section per term.
- Diagrams are Mermaid. Draw the C4 levels as flowcharts with `[Person]`, `[Software system]` and `[Container: technology]` labels. Every `sequenceDiagram` gets `autonumber` and, right under it, a numbered list explaining each arrow.
- A hand-written document elsewhere starts with front matter `type:` (tutorial, how-to, reference or explanation).
