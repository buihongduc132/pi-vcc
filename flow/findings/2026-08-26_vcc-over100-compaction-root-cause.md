# Finding: VCC compaction >100% — routing works, gate is geometry, working tree regresses prod

Date: 2026-08-26
Scope: pi-vcc ↔ pi-plugins/immediate-compaction ↔ pi-core 0.84.1
Trigger: user report ">100% / 500k not able to VCC"; reviewer flagged pi-vcc-direct adapter (N2/N3/N4/N5/N6).

## Evidence

pi-core = `~/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/`

- [E1] `core/agent-session.js:1385` — manual `compact()`: `prepareCompaction()` undefined → throw "Nothing to compact (session too small)".
- [E2] `core/agent-session.js:1605-1607` — auto `_runAutoCompaction()`: preparation undefined → **silent `return false` BEFORE `session_before_compact` emit (L1613-1614)**. Extension/VCC hook never asked.
- [E3] `core/compaction/compaction.js:492` — `prepareCompaction()` has **NO percent gate**. Returns undefined only on geometry: (a) last entry is compaction (retrigger), (b) empty summarize-window (boundaryStart==turn start after keepRecentTokens≈20k tail, L77/L308), (c) missing firstKeptEntry.id (migration).
- [E4] `core/session-manager.d.ts:140` — ext `ctx.sessionManager` = `ReadonlySessionManager` = `Pick<...>` — no `appendCompaction` (full `SessionManager.appendCompaction` exists at L223 but is not exposed to extensions; no mutation API, by design).
- [E5] `core/extensions/types.d.ts:446-447` — `session_before_compact` `reason` enum includes literal `"overflow"` (JSDoc prose: "context overflow recovery") → pi-core DOES reach emit on overflow path when preparation exists.
- [E6] Runtime proof (node v22): `import('file://…/pi-vcc/src/hooks/before-compact.ts')` → **ERR_MODULE_NOT_FOUND on the extensionless specifier `../core/summarize`** (Node ESM cannot resolve extensionless `.ts` imports; the `@mariozechner/pi-coding-agent` package itself IS present in the deployed copy's node_modules — earlier attribution to a missing package was wrong, corrected 2026-08-26 after verifier reproduction). pi runs on node, not bun; bun resolves extensionless `.ts`, which is why tests passed. Deployed copy: `~/.pi/agent/git/github.com/buihongduc132/pi-vcc/`.
- [E7] Prod deployed resolver `~/.pi/agent/extensions/immediate-compaction/lib/engine/resolver.ts` L35/L46: `>100% → piVccCompactionAdapter` (both kind=vcc and fallback). No `pi-vcc-direct.ts` in prod or staging. **Stage 3 (dev) was contaminated** by an adhoc deploy 2026-08-26T09:19Z (manifest ref e2f7c6a0, carried dead `pi-vcc-direct.ts` + importing resolver); purged and redeployed clean 2026-08-26 22:14 (adapters = `pi-vcc.ts` only, kind-only routing). Lesson: audit ALL stage dirs, not just prod.

## Conclusions

- [C1] Gate = turn geometry, never usage percent. Normal >100% sessions (multi-turn) pass → VCC hook fires → compacts. User's past ">100% VCC works" is real [E7].
- [C2] Actual incident mechanism: VCC compacts at ~444k → ONE giant tool-output turn blows to 500k → summarize-window empty within that single turn [E3b] → undefined → hook never emitted [E2] → stuck. Not a percent refusal.
- [C3] Uncommitted working-tree `pi-vcc-direct.ts` (pi-plugins) is dead-on-arrival: needs `appendCompaction` [E4, absent] + runtime `.ts` import [E6, fails]. If deployed it **regresses prod**: >100% loses `__pi_vcc__` marker (detect false → core engine → gate throw → silent error state).
- [C4] Upstream match: `earendil-works/pi` **#6879 (OPEN)** "auto-compaction never triggers after context grows past 100% until provider overflow" = same family; #8175 (closed, failures exposed to ext); #8651 (closed, reserve scaling).
- [C5] Incident memory gap: Hindsight banks (pi-plugins/projects) last written pre-incident; `hindsight-proxy` Nomad job was pending with 6 failed allocs since 08-24 — recovered later on 08-26 (proxy :24300 → HTTP 200); incident still absent from recall (no backfill).

## Fix direction (see requirement doc)

Delete pi-vcc-direct; >100% routes identical to ≤100%; loud onError; upstream #6879 for geometry trap; prevention = earlier trigger.

## References

- pi-vcc hook: `src/hooks/before-compact.ts` (buildOwnCut, __pi_vcc__, firstKeptEntryId="" sentinel)
- pi-vcc settings: `src/core/settings.ts:92` `overrideDefaultCompaction:false` default; **live config `~/.pi/agent/pi-vcc-config.json` sets `overrideDefaultCompaction: true`** → VCC hook claims ALL compactions (incl. pi-core auto-compact) whenever `session_before_compact` is emitted — marker not required in prod today. Trap [C2] unchanged: overflow with empty summarize-window never emits.
- pi-plugins working-tree diffs: resolver.ts, adapters/pi-vcc-direct.ts, index.ts (BHD-116), types.ts
- Upstream issues: https://github.com/earendil-works/pi/issues/6879, /8175, /8651
