import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs/promises before importing settings
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();

vi.mock("fs/promises", () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

// We need to mock dirname to control the directory path
// but it's used internally. Instead, mock the env var to control settingsPath().
const ORIGINAL_ENV = process.env.PI_VCC_CONFIG_PATH;

describe("scaffoldSettingsAsync", () => {
  let scaffoldSettingsAsync: () => Promise<void>;
  let DEFAULT_SETTINGS: Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Set a known config path
    process.env.PI_VCC_CONFIG_PATH = "/tmp/test-vcc/pi-vcc-config.json";
    // Re-import to pick up env var
    vi.resetModules();
    const mod = await import("../src/core/settings");
    scaffoldSettingsAsync = mod.scaffoldSettingsAsync;
    DEFAULT_SETTINGS = mod.DEFAULT_SETTINGS as Record<string, unknown>;
  });

  it("creates config file with defaults when no file exists", async () => {
    // readFile throws ENOENT → file doesn't exist
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockReadFile.mockRejectedValue(enoent);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    await scaffoldSettingsAsync();

    // Should mkdir for parent dir
    expect(mockMkdir).toHaveBeenCalledWith("/tmp/test-vcc", { recursive: true });
    // Should write default settings
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/test-vcc/pi-vcc-config.json",
      `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`,
    );
    // Should be called exactly once (create, no second write)
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it("does NOT clobber existing valid config (only fills missing keys)", async () => {
    const existing = { overrideDefaultCompaction: true, debug: false, legacyCancelBehavior: false, extraction: { references: { enabled: true, extraUrlPatterns: [], extraGithubRefPatterns: [], extraVersionPatterns: [], extraBranchPatterns: [] }, keySignals: { enabled: true, extraConstraintPatterns: [], extraDecisionPatterns: [], extraStatusPatterns: [] }, goals: { enabled: true, extraTaskVerbs: [], extraScopeChangeWords: [] } } };
    mockReadFile.mockResolvedValue(JSON.stringify(existing));
    mockWriteFile.mockResolvedValue(undefined);

    await scaffoldSettingsAsync();

    // All DEFAULT_SETTINGS keys already present → no write
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("fills in missing default keys and writes", async () => {
    // Partial config missing 'debug' key
    const partial = { overrideDefaultCompaction: false, extraction: { references: { enabled: true, extraUrlPatterns: [], extraGithubRefPatterns: [], extraVersionPatterns: [], extraBranchPatterns: [] }, keySignals: { enabled: true, extraConstraintPatterns: [], extraDecisionPatterns: [], extraStatusPatterns: [] }, goals: { enabled: true, extraTaskVerbs: [], extraScopeChangeWords: [] } } };
    mockReadFile.mockResolvedValue(JSON.stringify(partial));
    mockWriteFile.mockResolvedValue(undefined);

    await scaffoldSettingsAsync();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const written = mockWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.debug).toBe(false);
    // Existing key preserved
    expect(parsed.overrideDefaultCompaction).toBe(false);
  });

  it("no-ops when existing file has invalid JSON", async () => {
    mockReadFile.mockResolvedValue("this is not json {{{");

    await scaffoldSettingsAsync();

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it("creates parent directory if missing", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockReadFile.mockRejectedValue(enoent);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    await scaffoldSettingsAsync();

    expect(mockMkdir).toHaveBeenCalledWith("/tmp/test-vcc", { recursive: true });
  });

  it("no-ops on any error (best-effort, catches exceptions)", async () => {
    mockReadFile.mockRejectedValue(new Error("permission denied"));

    // Should not throw
    await expect(scaffoldSettingsAsync()).resolves.toBeUndefined();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("returns void/undefined (fire-and-forget style)", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockReadFile.mockRejectedValue(enoent);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    const result = await scaffoldSettingsAsync();
    expect(result).toBeUndefined();
  });
});
