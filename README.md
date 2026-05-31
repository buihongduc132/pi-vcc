# pi-vcc

[![npm](https://img.shields.io/npm/v/@sting8k/pi-vcc)](https://www.npmjs.com/package/@sting8k/pi-vcc)
[![license](https://img.shields.io/npm/l/@sting8k/pi-vcc)](https://spdx.org/licenses/MIT)

Algorithmic conversation compactor for [Pi](https://github.com/badlogic/pi-mono). No LLM calls — produces a brief transcript via extraction and formatting.

Inspired by [VCC](https://github.com/lllyasviel/VCC) **(View-oriented Conversation Compiler)**.

## Features

- **Zero LLM calls** — deterministic, same input always produces same output
- **35–99% token reduction** on real sessions (higher on longer sessions)
- **30–470ms latency** — no API calls, pure algorithmic extraction
- **4 semantic sections** — Session Goal, Outstanding Context, References, Key Signals
- **Brief transcript** with tool-call rollup and noise filtering
- **History search** via `vcc_recall` tool (lineage-scoped, expand, pagination)
- **Section merging** across repeated compactions with deduplication
- **Configurable extraction** — additive patterns for URLs, GitHub refs, versions, constraints, decisions, statuses

## Installation

### For humans (npm)

```bash
npm install @sting8k/pi-vcc
```

### For AI agents (pi settings.json)

Add to your pi `settings.json` packages array:

```json
{
  "packages": ["@sting8k/pi-vcc"]
}
```

### Git-sourced

In `settings.json`, reference the repo directly:

```json
{
  "packages": ["github:buihongduc132/pi-vcc"]
}
```

Or clone into `profile/git/github.com/buihongduc132/`:

```bash
git clone https://github.com/buihongduc132/pi-vcc.git profile/git/github.com/buihongduc132/pi-vcc
```

## Usage

Once installed, pi-vcc registers two hooks and one tool automatically:

### Commands

| Command | Description |
|---------|-------------|
| `/pi-vcc` | Trigger pi-vcc compaction explicitly |
| `/compact` | Handled by pi-vcc when `overrideDefaultCompaction: true` |

### Tool: `vcc_recall`

Search session history after compaction:

```
vcc_recall({ query: "auth bug", scope: "all", page: 1 })
vcc_recall({ expand: [0, 3], scope: "all" })
```

- **Default scope**: active lineage only; use `scope: "all"` for off-lineage branches
- Supports regex queries, pagination, and expand indices

## Configuration

Config file: `~/.pi/agent/pi-vcc-config.json` (auto-scaffolded with defaults).

```json
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

| Field | Default | Description |
|-------|---------|-------------|
| `overrideDefaultCompaction` | `false` | When `true`, pi-vcc handles all compaction triggers |
| `debug` | `false` | Write debug snapshot to `/tmp/pi-vcc-debug.json` |
| `extraction.*.enabled` | `true` | Enable/disable individual extraction categories |
| `extraction.*.extra*` | `[]` | Additive patterns (built-ins never removed) |

## License

MIT © [buihongduc132](https://github.com/buihongduc132)

Repository: [buihongduc132/pi-vcc](https://github.com/buihongduc132/pi-vcc)
