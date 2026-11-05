---
paths:
  - "docs/**"
---

# Writing this repo's documents

- `docs/ARCHITECTURE.md`, `docs/PRODUCT.md`, `docs/GLOSSARY.md` and `docs/decisions/` are generated from Imprimatur's database. Change them with `doc_section_upsert` (or in the Imprimatur panel), never in the file: the next export writes over a hand edit.
- The architecture follows arc42-lite chapters (goals, context, strategy, building-blocks, deployment, crosscutting, decisions, risks), the product its own (problem, users, goals, non-goals, features, metrics). Every new section names its chapter.
- A decision is a record: `adr` for how it is built, `pdr` for what the user gets. It is written to `docs/decisions/NNNN-*.md` in MADR 4 form. Link it to the section it shapes (`records: [id]`) and update that section.
- A new term, or a term that changes meaning, goes in the glossary, one section per term.
- A task analysis is a mini design doc: one section per chapter (context, goals, design, alternatives, risks).
- Diagrams are Mermaid. Draw the C4 levels as flowcharts with `[Person]`, `[Software system]` and `[Container: technology]` labels. Every `sequenceDiagram` gets `autonumber` and, right under it, a numbered list explaining each arrow.
- A hand-written document elsewhere starts with front matter `type:` (tutorial, how-to, reference or explanation).
