/**
 * Branch-coverage tests for previously uncovered branches in:
 *   - src/core/settings.ts   (lines 110, 158-179)
 *   - src/core/lineage.ts    (lines 12, 21)
 *   - src/tools/recall.ts    (lines 44, 101)
 *
 * Conventions mirror the existing suite:
 *   - real temp files for fs behaviour (cf. recall-tool-scope.test.ts)
 *   - vi.mock("fs/promises") only where the async helpers are isolated
 *     (cf. settings-scaffold.test.ts) — here we additionally isolate the
 *     *sync* `fs` module so the deprecated scaffoldSettings() can be driven
 *     through every branch without touching the real filesystem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRecallTool } from "../src/tools/recall";

// ─────────────────────────────────────────────────────────────────────────────
// settings.ts — readJson catch fallback (line 110) + loadSettings
// We drive the real async code path with real temp files so the catch branch
// is exercised by genuine ENOENT / invalid-JSON conditions.
// ─────────────────────────────────────────────────────────────────────────────
describe("settings.loadSettings / readJson catch fallback (line 110)", () => {
  const ORIGINAL_ENV = process.env.PI_VCC_CONFIG_PATH;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-vcc-loadsettings-"));
    process.env.PI_VCC_CONFIG_PATH = join(tmp, "config.json");
    vi.resetModules();
  });

  afterEach(() => {
    process.env.PI_VCC_CONFIG_PATH = ORIGINAL_ENV;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns DEFAULT_SETTINGS when config file is missing (readJson catch: ENOENT)", async () => {
    const { loadSettings, DEFAULT_SETTINGS } = await import("../src/core/settings");
    const s = await loadSettings();
    // readJson swallows the ENOENT and returns null → loadSettings returns defaults
    expect(s.overrideDefaultCompaction).toBe(DEFAULT_SETTINGS.overrideDefaultCompaction);
    expect(s.debug).toBe(DEFAULT_SETTINGS.debug);
    expect(s.legacyCancelBehavior).toBe(DEFAULT_SETTINGS.legacyCancelBehavior);
    expect(s.extraction.references.enabled).toBe(true);
    expect(s.extraction.goals.extraScopeChangeWords).toEqual([]);
  });

  it("returns DEFAULT_SETTINGS when config file is invalid JSON (readJson catch: parse error)", async () => {
    writeFileSync(process.env.PI_VCC_CONFIG_PATH!, "this is { not valid json {{{", "utf8");
    const { loadSettings, DEFAULT_SETTINGS } = await import("../src/core/settings");
    const s = await loadSettings();
    expect(s.overrideDefaultCompaction).toBe(DEFAULT_SETTINGS.overrideDefaultCompaction);
    expect(s.extraction.keySignals.enabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// settings.ts — deprecated sync scaffoldSettings() (lines 158-179)
// The function imports the *sync* `fs` module; we mock that module so we can
// drive each branch deterministically without touching the real disk.
// ─────────────────────────────────────────────────────────────────────────────
describe("settings.scaffoldSettings() sync (lines 158-179)", () => {
  const ORIGINAL_ENV = process.env.PI_VCC_CONFIG_PATH;

  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockMkdirSync: ReturnType<typeof vi.fn>;
  let mockWriteFileSync: ReturnType<typeof vi.fn>;
  let mockReadFileSync: ReturnType<typeof vi.fn>;
  let scaffoldSettings: () => void;
  let DEFAULT_SETTINGS: Record<string, unknown>;

  beforeEach(async () => {
    process.env.PI_VCC_CONFIG_PATH = "/tmp/test-vcc-sync/config.json";

    mockExistsSync = vi.fn();
    mockMkdirSync = vi.fn();
    mockWriteFileSync = vi.fn();
    mockReadFileSync = vi.fn();

    vi.resetModules();
    // `dirname` comes from "path" and resolves "/tmp/test-vcc-sync/config.json"
    // to "/tmp/test-vcc-sync"; we control behaviour purely via the fs mock.
    vi.doMock("fs", () => ({
      existsSync: mockExistsSync,
      mkdirSync: mockMkdirSync,
      writeFileSync: mockWriteFileSync,
      readFileSync: mockReadFileSync,
      // re-export anything else the module might touch at import time
      __esModule: true,
    }));

    const mod = await import("../src/core/settings");
    scaffoldSettings = mod.scaffoldSettings;
    DEFAULT_SETTINGS = mod.DEFAULT_SETTINGS as Record<string, unknown>;
  });

  afterEach(() => {
    process.env.PI_VCC_CONFIG_PATH = ORIGINAL_ENV;
    vi.doUnmock("fs");
    vi.resetModules();
  });

  it("creates parent dir + writes default config when both dir and file are missing (lines 161, 163-165)", () => {
    // First call: dir missing → true for "!existsSync(dir)"; second: file missing.
    mockExistsSync.mockReturnValueOnce(false).mockReturnValueOnce(false);
    mockMkdirSync.mockReturnValue(undefined);
    mockWriteFileSync.mockReturnValue(undefined);

    scaffoldSettings();

    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/test-vcc-sync", { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/test-vcc-sync/config.json",
      `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`,
    );
  });

  it("skips mkdir when parent dir already exists (line 161 false branch)", () => {
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockMkdirSync.mockReturnValue(undefined);
    mockWriteFileSync.mockReturnValue(undefined);

    scaffoldSettings();

    expect(mockMkdirSync).not.toHaveBeenCalled();
    // file was missing → still writes defaults
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns early without clobbering when file has invalid JSON (line 169 true branch)", () => {
    // dir exists, file exists
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValue("not valid json {{{");

    scaffoldSettings();

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("returns early without clobbering when parsed JSON is null (line 169 true branch)", () => {
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValue("null");

    scaffoldSettings();

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("fills missing default keys and writes when valid JSON is partial (lines 174-179 true branch)", () => {
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    // Partial config missing 'debug' and 'legacyCancelBehavior'
    const partial = { overrideDefaultCompaction: true, extraction: {} };
    mockReadFileSync.mockReturnValue(JSON.stringify(partial));
    mockWriteFileSync.mockReturnValue(undefined);

    scaffoldSettings();

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    // missing keys filled with defaults
    expect(parsed.debug).toBe(false);
    expect(parsed.legacyCancelBehavior).toBe(false);
    // existing user value preserved
    expect(parsed.overrideDefaultCompaction).toBe(true);
  });

  it("does not write when all default keys are already present (line 174 false, line 179 false)", () => {
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(DEFAULT_SETTINGS));
    mockWriteFileSync.mockReturnValue(undefined);

    scaffoldSettings();

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("swallows errors thrown inside the try block (best-effort, line 180 catch)", () => {
    // readFileSync throws a non-ENOENT error → caught by outer try/catch
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    expect(() => scaffoldSettings()).not.toThrow();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lineage.ts — getBranch() ?? [] (line 12) and getEntries?.() ?? [] (line 21)
// ─────────────────────────────────────────────────────────────────────────────
describe("getActiveLineageEntryIds nullish fallbacks (lines 12, 21)", () => {
  // Imported lazily so the module under test is fresh.
  const importLineage = async () => import("../src/core/lineage");

  it("falls back to [] when getBranch() returns null (line 12 ?? branch, then length 0)", async () => {
    const { getActiveLineageEntryIds } = await importLineage();
    const ids = getActiveLineageEntryIds({
      getBranch: () => null as unknown as ReturnType<() => any[]>,
      getEntries: () => [{ id: "fallback" }],
    });
    // branch was null → treated as [] → falls through to getEntries
    expect([...ids]).toEqual(["fallback"]);
  });

  it("falls back to [] when getBranch() returns undefined (line 12 ?? branch)", async () => {
    const { getActiveLineageEntryIds } = await importLineage();
    const ids = getActiveLineageEntryIds({
      getBranch: () => undefined as unknown as ReturnType<() => any[]>,
      getEntries: () => [{ id: "g1" }, { id: "g2" }],
    });
    expect([...ids]).toEqual(["g1", "g2"]);
  });

  it("uses getEntries() when getBranch returns an empty array (length 0 path → line 21)", async () => {
    const { getActiveLineageEntryIds } = await importLineage();
    const ids = getActiveLineageEntryIds({
      getBranch: () => [],
      getEntries: () => [{ id: "only-from-entries" }],
    });
    expect([...ids]).toEqual(["only-from-entries"]);
  });

  it("uses getEntries?.() optional-call when getBranch throws (line 21 ?.() branch)", async () => {
    const { getActiveLineageEntryIds } = await importLineage();
    const ids = getActiveLineageEntryIds({
      getBranch: () => {
        throw new Error("boom");
      },
      getEntries: () => [{ id: "x" }],
    });
    expect([...ids]).toEqual(["x"]);
  });

  it("returns empty set when getEntries is undefined and getBranch throws (line 21 ?.() → undefined)", async () => {
    const { getActiveLineageEntryIds } = await importLineage();
    const ids = getActiveLineageEntryIds({
      getBranch: () => {
        throw new Error("boom");
      },
      // getEntries intentionally omitted
    } as any);
    expect(ids.size).toBe(0);
  });

  it("filters out entries with falsy/missing ids in the getEntries fallback (line 21 + filter)", async () => {
    const { getActiveLineageEntryIds } = await importLineage();
    const ids = getActiveLineageEntryIds({
      getBranch: () => null as unknown as ReturnType<() => any[]>,
      getEntries: () => [
        { id: "keep" },
        { id: "" },
        { id: undefined },
        { id: null },
        {}, // no id field
      ] as any,
    });
    expect([...ids]).toEqual(["keep"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recall.ts — execute() early returns
//   line 44: !sessionFile  → "No session file available."
//   line 101: no query, no expand → default recent path with formatRecallOutput
// ─────────────────────────────────────────────────────────────────────────────
const registerTool = () => {
  let tool: any;
  registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any);
  return tool;
};

const invoke = async (tool: any, ctx: Record<string, unknown>, params: Record<string, unknown>) => {
  const result = await tool.execute("tool-call", params, undefined, undefined, ctx);
  return result;
};

describe("vcc_recall early returns (lines 44, 101)", () => {
  it("returns 'No session file available.' when getSessionFile() is null (line 44 true branch)", async () => {
    const tool = registerTool();
    const result = await invoke(
      tool,
      { sessionManager: { getSessionFile: () => null } },
      { query: "anything" },
    );
    expect(result.details).toBeUndefined();
    expect(result.content[0].text).toBe("No session file available.");
  });

  it("returns 'No session file available.' when getSessionFile() is undefined (line 44 true branch)", async () => {
    const tool = registerTool();
    const result = await invoke(
      tool,
      { sessionManager: { getSessionFile: () => undefined } },
      {},
    );
    expect(result.content[0].text).toBe("No session file available.");
  });

  const makeSession = (count: number) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-default-"));
    const file = join(dir, "session.jsonl");
    const lines = [];
    for (let i = 0; i < count; i++) {
      lines.push(
        JSON.stringify({ type: "message", id: `m${i}`, message: { role: "user", content: `lineage msg ${i}` } }),
      );
    }
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    return { dir, file };
  };

  it("returns default recent entries with no query and no expand, lineage scope (line 101)", async () => {
    const tool = registerTool();
    const { dir, file } = makeSession(3);
    try {
      const result = await invoke(
        tool,
        {
          sessionManager: {
            getSessionFile: () => file,
            getBranch: () => [{ id: "m0" }, { id: "m1" }, { id: "m2" }],
            getEntries: () => [{ id: "m0" }, { id: "m1" }, { id: "m2" }],
          },
        },
        {}, // no query, no expand, no scope
      );
      const text = result.content[0].text as string;
      // No "Scope: all" prefix (lineage default) and uses Session history header
      expect(text.startsWith("Scope: all")).toBe(false);
      expect(text).toContain("Session history");
      expect(text).toContain("#0 [user] lineage msg 0");
      expect(text).toContain("#2 [user] lineage msg 2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps default recent output at DEFAULT_RECENT and prefixes 'Scope: all' when scope is all (line 101 with scope branch)", async () => {
    const tool = registerTool();
    const { dir, file } = makeSession(30);
    try {
      const result = await invoke(
        tool,
        {
          sessionManager: {
            getSessionFile: () => file,
            getBranch: () => [],
            getEntries: () => Array.from({ length: 30 }, (_, i) => ({ id: `m${i}` })),
          },
        },
        { scope: "all" }, // no query, no expand → line 101, but scope=all branch
      );
      const text = result.content[0].text as string;
      expect(text.startsWith("Scope: all\n\n")).toBe(true);
      // Only last 25 messages kept (DEFAULT_RECENT), spanning indices 5..29
      expect(text).toContain("#29 [user] lineage msg 29");
      expect(text).not.toContain("#4 [user] lineage msg 4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 'No entries' message when default recent path has zero messages (line 101, empty result)", async () => {
    const tool = registerTool();
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-empty-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(file, "", "utf8");
    try {
      const result = await invoke(
        tool,
        {
          sessionManager: {
            getSessionFile: () => file,
            getBranch: () => [],
            getEntries: () => [],
          },
        },
        {},
      );
      const text = result.content[0].text as string;
      expect(text).toBe("No entries in session history.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
