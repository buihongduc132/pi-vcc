# pi-vcc

[![npm](https://img.shields.io/npm/v/@sting8k/pi-vcc)](https://www.npmjs.com/package/@sting8k/pi-vcc)

Algorithmic conversation compactor for [Pi](https://github.com/badlogic/pi-mono). No LLM calls — produces a brief transcript via extraction and formatting.

Inspired by [VCC](https://github.com/lllyasviel/VCC) **(View-oriented Conversation Compiler)**.

## Demo

![pi-vcc demo](./demo.gif)

## Why pi-vcc

|  | Pi default | pi-vcc |
|---|---|---|
| **Method** | LLM-generated summary | Algorithmic extraction, no LLM |
| **Determinism** | Non-deterministic, can hallucinate | Same input = same output, always |
| **Token reduction** | Varies | 35-99% on real sessions (higher on longer sessions) |
| **Compaction latency** | Waits for LLM call | 30-470ms, no API calls |
| **History after compaction** | Gone — agent only sees summary | Active lineage searchable via `vcc_recall` (`scope:"all"` available) |
| **Repeated compactions** | Each rewrite risks losing more | Sections merge and accumulate |
| **Cost** | Burns tokens on summarization call | Zero — no API calls |
| **Structure** | Free-form prose | Brief transcript + 4 semantic sections |

### Real session metrics

Measured on real session JSONLs under `~/.pi/agent/sessions` (chars = rendered message text).

| Session | Messages | Before | After | Reduction | Time |
|---|---|---|---|---|---|
| Session A | 2,943 | 997,162 | 7,959 | 99.2% | 64ms |
| Session B | 1,703 | 428,334 | 7,762 | 98.2% | 29ms |
| Session C | 1,657 | 424,183 | 9,577 | 97.7% | 54ms |
| Session D | 1,004 | 2,258,477 | 4,439 | 99.8% | 30ms |
| Session E | 486 | 295,006 | 11,163 | 96.2% | 30ms |
| Session F | 46 | 5,234 | 3,364 | 35.7% | 5ms |
| Session G | 27 | 8,595 | 2,489 | 71.0% | 2ms |

## Features

- **No LLM** — purely algorithmic, zero extra API cost
- **Brief transcript** — chronological conversation flow, each tool call collapsed to a one-liner with `(#N)` refs, text truncated to keep it compact
- **7 semantic sections** — session goal, files & changes, commits, references, key signals, outstanding context, user preferences
- **Bounded merge** — rolling sections re-capped after merge instead of growing unbounded
- **Lossless recall** — `vcc_recall` reads raw session JSONL, so active-lineage history stays searchable across compactions
- **Scoped recall** — default search is active lineage; use `scope:"all"` / `scope:all` to intentionally search across all lineages
- **Regex search** — `vcc_recall` supports regex patterns (`hook|inject`, `fail.*build`) and OR-ranked multi-word queries
- **Result ranking** — search results ranked by term relevance, rare terms weighted higher than common ones
- **`/pi-vcc-recall`** — slash command to search history directly, results shown as collapsible message and auto-fed to agent as context
- **Fallback cut** — still works when Pi core returns nothing to summarize
- **`/pi-vcc`** — manual compaction on demand

## Install

```bash
pi install https://github.com/buihongduc132/pi-vcc
```

Or from npm (upstream):

```bash
pi install npm:@sting8k/pi-vcc
```

Or try without installing:

```bash
pi -e https://github.com/buihongduc132/pi-vcc
```

## Usage

Once installed, pi-vcc registers a `session_before_compact` hook.

- Run `/pi-vcc` to trigger pi-vcc compaction manually.
- By default, `/compact` and auto-threshold compactions still go through pi core (LLM-based). Set `overrideDefaultCompaction: true` in the config to let pi-vcc handle all compaction paths.
- To search older active-lineage history after compaction, use `vcc_recall`.
- To intentionally search across all lineages, pass `scope:"all"` to `vcc_recall` or run `/pi-vcc-recall <query> scope:all`.
- To search and feed results to agent yourself, run `/pi-vcc-recall <query> [page:N]`.
  - Tip: type `/recall` and Pi will autocomplete to `/pi-vcc-recall`.

### How compaction works

Pi splits the conversation at the **last user message**. Everything after — the **kept tail** — stays intact and untouched. pi-vcc only summarizes the older portion before that cut point.

### Compacted message structure

```
[Session Goal]
- Fix the authentication bug in login flow
- [Scope change]
- Also update the session token refresh logic

[Files And Changes]
- Modified: src/auth/session.ts
- Created: tests/auth-refresh.test.ts

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[References]
- URL: https://docs.auth.com/refresh-tokens
- GitHub: #42, PR #7
- Version: v2.3.1

[Key Signals]
- Constraint: must not break backward compatibility
- Decision: decided to use Redis for session storage
- Status: DONE — auth module migrated

[Outstanding Context]
- lint check still failing on line 42

[User Preferences]
- Prefer Vietnamese responses
- Always run tests before committing

[user]
Fix the auth bug, users can't log in after password reset

[assistant]
Root cause is a missing token refresh after password reset...
* bash "bun test tests/auth.test.ts" (#12)
* edit "src/auth/session.ts" (#14)
* bash "bun test tests/auth.test.ts" (#16)
...(28 earlier lines omitted)
```

Sections appear only when relevant — a session with no git commits won't have `[Commits]`.

**Sections:**

| Section | Description |
|---|---|
| `[Session Goal]` | Initial goal + scope changes (regex-based extraction) |
| `[Files And Changes]` | Modified/created files from tool calls (capped, paths trimmed to common root) |
| `[Commits]` | Git commits made during the session (last 8, hash + first line) |
| `[References]` | URLs, GitHub refs (#42, PR #7, owner/repo), versions, branches, commit refs |
| `[Key Signals]` | NLP-extracted constraints, decisions, and status markers |
| `[Outstanding Context]` | Unresolved items — errors, pending questions |
| `[User Preferences]` | Regex-extracted from user messages (`always`, `never`, `prefer`...) |
| Brief transcript | Chronological conversation flow — rolling window of ~120 recent lines, tool calls collapsed to one-liners with `(#N)` refs |

**Merge policy:**
- `Session Goal`, `User Preferences`: concise sticky sections
- `Outstanding Context`: fresh-only (replaced each compaction)
- `Files And Changes`, `Commits`: unique union across compactions
- Brief transcript: rolling window, older lines drop off

## Recall (Lossless History)

Pi's default compaction discards old messages permanently. After compaction, the agent only sees the summary.

`vcc_recall` bypasses this by reading the raw session JSONL file directly. By default it searches only the active conversation lineage, regardless of how many compactions have happened. Use `scope:"all"` only when you intentionally want to include off-lineage branches.

### Search

Queries support **regex** and **multi-word OR logic** ranked by relevance:

```
vcc_recall({ query: "auth token" })                         // active-lineage OR search, ranked
vcc_recall({ query: "auth token", page: 2 })                // paginated (5 results/page)
vcc_recall({ query: "hook|inject" })                         // regex pattern
vcc_recall({ query: "fail.*build" })                         // regex pattern
vcc_recall({ query: "auth token", scope: "all" })           // search all lineages
```

Manual slash command:

```
/pi-vcc-recall auth token scope:all
```

### Browse

Without a query, returns the last 25 entries as brief summaries:

```
vcc_recall()
vcc_recall({ scope: "all" })  // browse recent entries across all lineages
```

### Expand

Returns full untruncated content for specific indices found via search:

```
vcc_recall({ expand: [41, 42] })                 // active-lineage expand
vcc_recall({ expand: [41, 42], scope: "all" })   // expand across all lineages
```

Typical workflow: **search → find relevant entry indices → expand those indices for full content**.

> Some tool results are truncated by Pi core at save time. `expand` returns everything in the JSONL but can't recover what Pi already cut.

## Pipeline

1. **Normalize** — raw Pi messages → uniform blocks (user, assistant, tool_call, tool_result, thinking)
2. **Filter noise** — strip system messages, empty blocks
3. **Build sections** — extract goal, file paths, commits, references, key signals, blockers, preferences
4. **Brief transcript** — chronological conversation flow, tool calls collapsed to one-liners, text truncated
5. **Format** — render into bracketed sections + transcript
6. **Merge** — if previous summary exists: sticky sections merge, volatile sections replace, transcript rolls

## Config

Config lives at `~/.pi/agent/pi-vcc-config.json` (auto-scaffolded on first load with safe defaults). JSON schema: [`pi-vcc-config.schema.json`](./pi-vcc-config.schema.json).

### Full config with defaults

```jsonc
{
  "overrideDefaultCompaction": false,
  "debug": false,
  "extraction": {
    "references": {
      "enabled": true,
      "extraUrlPatterns": [],
      "extraGithubRefPatterns": [],
      "extraVersionPatterns": [],
      "extraBranchPatterns": []
    },
    "keySignals": {
      "enabled": true,
      "extraConstraintPatterns": [],
      "extraDecisionPatterns": [],
      "extraStatusPatterns": []
    },
    "goals": {
      "enabled": true,
      "extraTaskVerbs": [],
      "extraScopeChangeWords": []
    }
  }
}
```

### Top-level settings

| Key | Default | Description |
|-----|---------|-------------|
| `overrideDefaultCompaction` | `false` | When `true`, pi-vcc handles ALL compactions (`/compact`, auto-threshold, `/pi-vcc`). When `false`, only `/pi-vcc` triggers pi-vcc. |
| `debug` | `false` | Write debug snapshot to `/tmp/pi-vcc-debug.json` on each compaction. |

### Extraction config

All `extra*` arrays are **additive** — patterns append to built-ins. Built-in patterns are never removed.

#### `extraction.references`

Controls the `[References]` section. Extracts from user + assistant messages only.

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Disable to skip reference extraction. |
| `extraUrlPatterns` | `[]` | Additional URL regex patterns (built-in: `https?://\S+`). |
| `extraGithubRefPatterns` | `[]` | Additional GitHub ref patterns (built-in: `#\d+`, `PR\s*#\d+`, `owner/repo`). |
| `extraVersionPatterns` | `[]` | Additional version patterns (built-in: `v?\d+\.\d+\.\d+`). |
| `extraBranchPatterns` | `[]` | Additional branch patterns (built-in: `feat|fix|hotfix|release|.../xxx`). |

**Built-in extraction:**
- URLs: `https?://\S+` (trailing punctuation stripped, IP:port supported)
- GitHub refs: bare issue `#42`, PR `PR #7`, owner/repo `buihongduc132/pi-plugins`, full GitHub URLs
- Versions: `v1.2.3`, `1.0.0` (IP octets filtered out)
- Branches: `feat/xxx`, `fix/xxx`, `hotfix/xxx`, `release/xxx`, `chore/xxx`, `refactor/xxx`, `docs/xxx`, `test/xxx`
- Commit refs: 7-12 hex chars with at least one `[a-f]` letter

#### `extraction.keySignals`

Controls the `[Key Signals]` section. Constraints and decisions from user messages only; status from user + assistant.

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Disable to skip key signal extraction. |
| `extraConstraintPatterns` | `[]` | Additional constraint regex patterns. |
| `extraDecisionPatterns` | `[]` | Additional decision regex patterns. |
| `extraStatusPatterns` | `[]` | Additional status **keywords** (not regex — plain words). |

**Built-in patterns:**
- Constraints: `don't`, `must not`, `cannot`, `forbidden`, `disallowed`, `off-limits`, `out of scope`, `excluded`, `do not`
- Decisions: `decided`, `let's use`, `going with`, `chose`, `we'll use`
- Status: `DONE`, `TODO`, `WIP`, `blocked`, `resolved` (must be at sentence start or after punctuation)

#### `extraction.goals`

Controls the `[Session Goal]` section.

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Disable to skip goals extraction. |
| `extraTaskVerbs` | `[]` | Additional task verbs (built-in: `fix`, `implement`, `add`, `create`, ...). |
| `extraScopeChangeWords` | `[]` | Additional scope-change keywords (built-in: `instead`, `actually`, `change of plan`, ...). |

### Example: adding custom patterns

```jsonc
{
  "extraction": {
    "references": {
      "extraGithubRefPatterns": ["[A-Z]+-\\d+"]  // Match JIRA-1234
    },
    "keySignals": {
      "extraConstraintPatterns": ["\\bstrictly prohibited\\b"],
      "extraStatusPatterns": ["REVIEWED", "SHIPPED", "CANCELLED"]
    }
  }
}
```

### Config behavior

- **Hot reload**: config is re-read on each compaction. No restart needed.
- **Safe defaults**: missing keys = defaults. Invalid JSON = ignored.
- **No crash**: config errors never prevent compaction from working.
- **Env override**: set `PI_VCC_CONFIG_PATH` to use a custom config file path.

## Related Work

- [VCC](https://github.com/lllyasviel/VCC) — the original transcript-preserving conversation compiler
- [Pi](https://github.com/badlogic/pi-mono) — the AI coding agent this extension is built for

## License

MIT
