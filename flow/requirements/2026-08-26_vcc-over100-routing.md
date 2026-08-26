# Requirement: VCC overflow routing — one path for all percentages, no knobs

Date: 2026-08-26
Origin: user — "Given with >100 ; we are just cutting knobs , how can we make it to be able to run at 100% as well ?" + ">100% and the knobs thing into requirement"
Context: `flow/findings/2026-08-26_vcc-over100-compaction-root-cause.md`

## R1 — Single routing path

Engine selection MUST be decided SOLELY by `engine.kind`; usage percent MUST NOT appear anywhere in routing (no `usagePercent > 100` special branch).

**Behavior delta (intentional, knob removal):** the previously deployed resolver FORCED VCC at >100% for ALL kinds (final fallback). After R1 the configured kind wins at any percent — including >100%: `kind=vcc|auto(VCC detected)` → VCC adapter; `kind=core` → core engine; `kind=command` → command engine; `kind=custom` (or load failure) → custom/core. This is deliberate: percent-based special-casing is the knob being removed.

Rationale: pi-core gate checks turn geometry, never percent [E3]; percent-forcing existed only to reach a dead adapter [C3].

## R2 — Delete pi-vcc-direct

`profile/extensions/immediate-compaction/lib/engine/adapters/pi-vcc-direct.ts` MUST be deleted, with its resolver imports and detect()-gate tests. Extension layer has no legal write path (`ReadonlySessionManager` [E4]) and no runtime `.ts` import [E6].

## R3 — Marker integrity (exact-match, append FORBIDDEN)

The `__pi_vcc__` marker MUST reach pi-core's `session_before_compact` customInstructions in ALL trigger paths, and MUST equal the literal `"__pi_vcc__"` EXACTLY — pi-vcc's hook matches with strict equality (`customInstructions === "__pi_vcc__"`, `src/hooks/before-compact.ts`), and with `overrideDefaultCompaction:false` (default) any non-exact value silently bypasses VCC.

Therefore: appending coordinator customInstructions to the marker is **FORBIDDEN** (breaks strict-equality → VCC silently skipped → core LLM compaction runs instead). When coordinator customInstructions exist alongside the marker, they MUST be logged (plugin logger) and dropped from the request.

## R4 — Loud failure

Compaction failure (`onError`, coordinator error phase) MUST surface a user-visible notify. Silent `phase="error"` state is forbidden (route-around-broken-silently violation).

## R5 — Non-goals

- NO attempt to fix pi-core geometry trap (single-giant-turn empty summarize-window [C2]) from extension layer. Track upstream #6879; revisit only if incident recurs after R1–R4.
- `overrideDefaultCompaction` stays AS CONFIGURED (live: `true` — VCC claims all emitted compactions; this predates and is independent of routing). No flip either way in this change.

## Acceptance

- [x] Resolver: no `usagePercent` conditional remains (kind-only routing; `_usagePercent` ignored) — verified repo + stage 3 post-redeploy
- [x] `pi-vcc-direct.ts` absent from repo AND from every deploy stage — verified prod/staging/dev 2026-08-26 22:14
- [ ] `bun test` (immediate-compaction) green; existing 5 silent-mode failures documented as pre-existing, not introduced (current: 46 pass / 5 pre-existing fail — remaining green-up tracked separately)
- [ ] Simulated >100% multi-turn session compacts with `details.compactor === "pi-vcc"` (kind=auto/VCC detected)
- [ ] Routing table identical across percents per R1 delta: kind=vcc/auto→VCC at BOTH ≤100% and >100%; kind=core→core at both; kind=command→command at both; VCC-undetectable auto→core at both
- [ ] R3: request carrying coordinator customInstructions still delivers EXACT `__pi_vcc__` to pi-core (log shows dropped text)
