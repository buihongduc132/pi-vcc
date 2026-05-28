import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

export const SETTINGS_PATH_DEFAULT = join(homedir(), ".pi", "agent", "pi-vcc-config.json");
const settingsPath = (): string => process.env.PI_VCC_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT;
/** Backwards-compat export. Resolves at access time, not import time. */
export const SETTINGS_PATH = settingsPath();

export interface ExtractionCategoryConfig {
  /** When false, skip this extraction entirely. Default: true */
  enabled: boolean;
}

export interface ReferencesConfig extends ExtractionCategoryConfig {
  /** Additional URL regex patterns (added to built-in `https?://\\S+`). */
  extraUrlPatterns: string[];
  /** Additional GitHub ref patterns (added to built-in `#\\d+`, `PR\\s*#\\d+`, `owner/repo`). */
  extraGithubRefPatterns: string[];
  /** Additional version patterns (added to built-in `v?\\d+\\.\\d+\\.\\d+`). */
  extraVersionPatterns: string[];
  /** Additional branch patterns (added to built-in `feat|fix|.../xxx`). */
  extraBranchPatterns: string[];
}

export interface KeySignalsConfig extends ExtractionCategoryConfig {
  /** Additional constraint patterns (added to built-in `don't|must not|...`). */
  extraConstraintPatterns: string[];
  /** Additional decision patterns (added to built-in `decided|let's use|...`). */
  extraDecisionPatterns: string[];
  /** Additional status patterns (added to built-in `DONE|TODO|WIP|...`). */
  extraStatusPatterns: string[];
}

export interface GoalsConfig extends ExtractionCategoryConfig {
  /** Additional task verbs (added to built-in `fix|implement|add|...`). */
  extraTaskVerbs: string[];
  /** Additional scope change keywords (added to built-in `instead|actually|...`). */
  extraScopeChangeWords: string[];
}

export interface ExtractionConfig {
  /** References extractor: URLs, GitHub refs, versions, branches. */
  references: ReferencesConfig;
  /** Key Signals extractor: constraints, decisions, status markers. */
  keySignals: KeySignalsConfig;
  /** Goals extractor tweaks. */
  goals: GoalsConfig;
}

export interface PiVccSettings {
  /**
   * When true, pi-vcc handles ALL compactions:
   *   - /compact (no args)
   *   - /compact <text>
   *   - auto threshold / overflow
   *   - /pi-vcc (always handled regardless)
   *
   * When false (default), pi-vcc only handles /pi-vcc; everything else
   * falls back to pi core's default LLM-based compaction.
   */
  overrideDefaultCompaction: boolean;
  /** Write debug snapshot to /tmp/pi-vcc-debug.json on each compaction. */
  debug: boolean;
  /** Fine-grained extraction configuration. All patterns are ADDITIVE — built-ins are never removed. */
  extraction: ExtractionConfig;
}

const DEFAULT_EXTRACTION: ExtractionConfig = {
  references: {
    enabled: true,
    extraUrlPatterns: [],
    extraGithubRefPatterns: [],
    extraVersionPatterns: [],
    extraBranchPatterns: [],
  },
  keySignals: {
    enabled: true,
    extraConstraintPatterns: [],
    extraDecisionPatterns: [],
    extraStatusPatterns: [],
  },
  goals: {
    enabled: true,
    extraTaskVerbs: [],
    extraScopeChangeWords: [],
  },
};

export const DEFAULT_SETTINGS: PiVccSettings = {
  overrideDefaultCompaction: false,
  debug: false,
  extraction: DEFAULT_EXTRACTION,
};

const readJson = async (path: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (e) {
    // Intentional fallback: if the file doesn't exist or is invalid JSON, treat as empty.
    return null;
  }
};

function deepMergeExtraction(parsed: Record<string, unknown>): ExtractionConfig {
  const ext = (parsed.extraction ?? {}) as Record<string, unknown>;
  const merge = <T extends ExtractionCategoryConfig>(
    defaults: T,
    user: Record<string, unknown>,
  ): T => {
    const result = { ...defaults };
    if (typeof user.enabled === "boolean") result.enabled = user.enabled;
    for (const key of Object.keys(defaults)) {
      if (key === "enabled") continue;
      const defVal = defaults[key as keyof T];
      const userVal = user[key];
      // Arrays: user value replaces (not merges) to allow full control
      if (Array.isArray(defVal) && Array.isArray(userVal)) {
        (result as Record<string, unknown>)[key] = userVal;
      }
    }
    return result;
  };
  return {
    references: merge(DEFAULT_EXTRACTION.references, (ext.references ?? {}) as Record<string, unknown>),
    keySignals: merge(DEFAULT_EXTRACTION.keySignals, (ext.keySignals ?? {}) as Record<string, unknown>),
    goals: merge(DEFAULT_EXTRACTION.goals, (ext.goals ?? {}) as Record<string, unknown>),
  };
}

export async function loadSettings(): Promise<PiVccSettings> {
  const parsed = await readJson(settingsPath());
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  const { extraction: _, ...topLevel } = { ...DEFAULT_SETTINGS, ...(parsed as Partial<PiVccSettings>) };
  const extraction = deepMergeExtraction(parsed);
  return { ...topLevel, extraction } as PiVccSettings;
}

/**
 * Ensure ~/.pi/agent/pi-vcc-config.json exists with default keys.
 * - File missing → create with full default block.
 * - File exists but invalid JSON → no-op (don't clobber user file).
 * - File exists and valid → fill in missing default keys, preserve existing values.
 */
/**
 * @deprecated Use scaffoldSettingsAsync() instead — sync fs blocks the event loop in extension hooks.
 */
export function scaffoldSettings(): void {
  try {
    const path = settingsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
      return;
    }

    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object") return; // don't clobber

    let changed = false;
    const next: Record<string, unknown> = { ...parsed };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in next)) {
        next[key] = value;
        changed = true;
      }
    }
    if (changed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch (e) {
    // Intentional fallback: settings scaffolding is best-effort and should not crash the extension load.
  }
}

/**
 * Async version of scaffoldSettings(). Uses fs/promises to avoid blocking the event loop.
 * - File missing → create with full default block.
 * - File exists but invalid JSON → no-op (don't clobber user file).
 * - File exists and valid → fill in missing default keys, preserve existing values.
 */
export async function scaffoldSettingsAsync(): Promise<void> {
  try {
    const path = settingsPath();
    const dir = dirname(path);

    let data: string;
    try {
      data = await readFile(path, "utf-8");
    } catch (e: unknown) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist → create parent dir + default config
        await mkdir(dir, { recursive: true });
        await writeFile(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
      }
      return;
    }

    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return; // don't clobber

    let changed = false;
    const next: Record<string, unknown> = { ...parsed };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in next)) {
        next[key] = value;
        changed = true;
      }
    }
    if (changed) await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch (e) {
    // Intentional fallback: settings scaffolding is best-effort and should not crash the extension load.
  }
}
