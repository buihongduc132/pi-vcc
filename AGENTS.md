# pi-vcc (VCC — Verbose-Context Compactor for pi)

pi extension: deterministic context compaction replacing LLM summarization (buildOwnCut + compile, `__pi_vcc__` marker on `session_before_compact`).

## Layout

- `src/hooks/before-compact.ts` — pi hook, buildOwnCut, markers, guards
- `src/core/` — settings, summarize/compile pipeline
- `flow/` — project knowledge base (findings / requirements / plans)

## Docs

- `flow/findings/2026-08-26_vcc-over100-compaction-root-cause.md` — >100% gate = turn geometry not percent; prod routing OK; pi-vcc-direct dead-on-arrival; upstream pi#6879
- `flow/requirements/2026-08-26_vcc-over100-routing.md` — R1-R5: one routing path all percentages, delete pi-vcc-direct, marker integrity, loud failure
- `flow/plans/20260515-1300/plan.md` — extractors + configurable rules plan
