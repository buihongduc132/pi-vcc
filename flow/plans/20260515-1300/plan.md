# Plan: Enhance pi-vcc Extractors + Configurable Rules

## User Context (verbatim)

> "Do it be able to capture: url like ? ALSO what are others important mark / anchor that it should capture but currently it is not? Also what are NLP keywords that it can capture for better information as well?"
> "make it to be able to configured as a config file as well (JUST adding, not removing the rules)"
> "TDD approach; must have verifier loop; LOTS of test cases"

## Problem

pi-vcc compaction loses critical information:
1. **URLs** — explicitly filtered OUT by `NON_GOAL_RE` in `goals.ts`
2. **GitHub refs** — `#42`, `PR #7`, `@user`, `owner/repo` not captured
3. **Version/context anchors** — semver, branch names, commit refs, error codes
4. **NLP signals** — constraints, decisions, status changes not extracted
5. **No configurability** — all regexes are hardcoded, users can't tune them

## Declarative Target State

### 1. New Section: `[References]` in output

```
[References]
- URL: https://docs.example.com/api/v2
- URL: http://100.114.135.99:4747
- GitHub: #42, PR #7, buihongduc132/pi-plugins
- Version: v2.3.1, @1.0.0
- Branch: feat/new-auth
- CommitRef: abc1234
```

### 2. New Section: `[Key Signals]` in output

```
[Key Signals]
- Constraint: must not push to main directly
- Decision: use Redis for caching instead of in-process LRU
- Status: DONE — auth module migrated
- Blocker: CI fails on Node 18
```

### 3. Configurable extraction rules via `pi-vcc-config.json`

```jsonc
{
  // Existing settings preserved
  "overrideDefaultCompaction": false,
  "debug": false,
  
  // NEW: extraction config (additive only — defaults match current behavior)
  "extraction": {
    "references": {
      "enabled": true,
      "urlPatterns": ["https?://\\S+"],           // additive to built-in
      "githubRefPatterns": ["#\\d+", "PR\\s*#\\d+"], // additive
      "versionPatterns": ["v?\\d+\\.\\d+\\.\\d+"],
      "branchPatterns": ["\\b(?:feat|fix|main|develop)/[\\w-]+"]
    },
    "keySignals": {
      "enabled": true,
      "constraintPatterns": ["\\b(must not|don'?t|cannot|forbidden|never)\\b"],
      "decisionPatterns": ["\\b(decided|let'?s use|going with|chose)\\b"],
      "statusPatterns": ["\\b(DONE|TODO|WIP|blocked|resolved)\\b"]
    },
    "goals": {
      // Can ADD patterns to existing extractors, never remove
      "extraTaskVerbs": [],
      "extraScopeChangeWords": []
    }
  }
}
```

### 4. No breaking changes

- All existing extractors unchanged
- Existing tests must continue to pass
- New sections appear AFTER existing sections in output
- Config defaults = current behavior + new extractors enabled

## Implementation Tasks (TDD)

### Phase 1: New Extractor — References

| # | Task | Files | Test First |
|---|------|-------|------------|
| 1.1 | Create `src/extract/references.ts` — extract URLs, GitHub refs, versions, branches, commit refs | `extract/references.ts` | `tests/extract-references.test.ts` |
| 1.2 | Wire into `buildSections` — add `references` field to `SectionData` | `sections.ts`, `build-sections.ts` | `tests/build-sections.test.ts` |
| 1.3 | Wire into `formatSummary` — render `[References]` section | `format.ts` | `tests/format.test.ts` |
| 1.4 | Wire into `mergePrevious` — merge references across compactions | `summarize.ts` | `tests/compile.test.ts` |

### Phase 2: New Extractor — Key Signals

| # | Task | Files | Test First |
|---|------|-------|------------|
| 2.1 | Create `src/extract/signals.ts` — extract constraints, decisions, status markers | `extract/signals.ts` | `tests/extract-signals.test.ts` |
| 2.2 | Wire into `buildSections` + `formatSummary` + `mergePrevious` | `sections.ts`, `build-sections.ts`, `format.ts`, `summarize.ts` | extend existing tests |

### Phase 3: Configurable Rules

| # | Task | Files | Test First |
|---|------|-------|------------|
| 3.1 | Extend `PiVccSettings` with `extraction` config schema | `settings.ts` | `tests/settings.test.ts` |
| 3.2 | Pass config to extractors — patterns become configurable (defaults = current) | all extractors | extend all extractor tests |
| 3.3 | Fix `goals.ts` `NON_GOAL_RE` — URLs no longer filtered from goals (moved to dedicated extractor) | `extract/goals.ts` | `tests/extract-goals.test.ts` |

### Phase 4: Comprehensive Test Coverage

| # | Task |
|---|------|
| 4.1 | Edge cases: multi-line URLs, malformed refs, duplicate dedup |
| 4.2 | Config override: custom patterns replace defaults |
| 4.3 | Merge across compactions: references persist correctly |
| 4.4 | Backwards compat: output format identical when new sections empty |

## Test Cases (Detailed)

### extract-references.test.ts

```
URLs:
- http://example.com
- https://docs.site.com/api/v2#section
- http://100.114.135.99:4747
- file:///path/to/file
- URL inside markdown [text](url)
- Multiple URLs in one message
- URL at line boundary
- Dedup same URL across blocks
- Skip URLs that are only tool_result noise (large JSON dumps)

GitHub refs:
- #42, #1234
- PR #7, pr#12
- Issue #5
- @username mentions
- owner/repo paths (e.g., buihongduc132/pi-plugins)
- Full GitHub URLs (https://github.com/owner/repo/issues/42)

Versions:
- v1.2.3, v0.3.12
- @1.0.0, @^2.0.0
- semver ranges: >=1.0.0 <2.0.0

Branches:
- feat/new-auth, fix/login-bug
- main, develop, master (only if context suggests branch ref)

Commit refs:
- abc1234, abc1234567 (7-12 hex chars, standalone)
- NOT inside git commit output (already handled by commits extractor)
```

### extract-signals.test.ts

```
Constraints:
- "must not push to main directly"
- "don't use any external deps"
- "cannot modify the public API"
- "forbidden to write to /etc"
- CONSTRAINT_RE from summary: /\b(don'?t|must not|cannot|forbidden|disallowed|off[- ]limits|out of scope|excluded|do not)\b/i

Decisions:
- "decided to use Redis"
- "let's go with approach B"
- "going with the microservice pattern"
- "chose SQLite for simplicity"

Status markers:
- "DONE — auth migrated"
- "WIP: still debugging"
- "TODO: add tests"
- "blocked on upstream fix"
- "resolved: was a typo"

Negatives (should NOT match):
- Questions ("should we use X?")
- Hypotheticals ("what if we can't?")
- Code comments in tool results
```

### Config tests

```
- Default config = all extractors enabled with built-in patterns
- Custom patterns additive (append to defaults)
- Disable specific extractor via enabled: false
- Invalid config gracefully ignored (fallback to defaults)
- Config hot-reload (re-read on each compaction)
```

## Risk Assessment

| Risk | Level | Mitigation |
|------|-------|------------|
| Breaking existing output format | LOW | New sections only; existing untouched |
| Performance (regex on every block) | LOW | Patterns pre-compiled; only user/assistant blocks scanned |
| False positives (refs in code dumps) | MEDIUM | Filter tool_result blocks; only scan user + assistant |
| Config migration | LOW | scaffoldSettings fills missing keys |

## PR Target

`buihongduc132/pi-vcc` (fork) → `sting8k/pi-vcc` (upstream)

Branch: `feat/enhance-extractors-configurable`
