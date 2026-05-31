import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../src/core/settings";

describe("settings", () => {
  it("DEFAULT_SETTINGS has extraction config with all categories", () => {
    expect(DEFAULT_SETTINGS.extraction).toBeDefined();
    expect(DEFAULT_SETTINGS.extraction.references.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.extraction.keySignals.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.extraction.goals.enabled).toBe(true);
  });

  it("DEFAULT_SETTINGS extraction arrays are empty (additive only)", () => {
    expect(DEFAULT_SETTINGS.extraction.references.extraUrlPatterns).toEqual([]);
    expect(DEFAULT_SETTINGS.extraction.references.extraGithubRefPatterns).toEqual([]);
    expect(DEFAULT_SETTINGS.extraction.references.extraVersionPatterns).toEqual([]);
    expect(DEFAULT_SETTINGS.extraction.references.extraBranchPatterns).toEqual([]);
    expect(DEFAULT_SETTINGS.extraction.keySignals.extraConstraintPatterns).toEqual([]);
    expect(DEFAULT_SETTINGS.extraction.keySignals.extraDecisionPatterns).toEqual([]);
    expect(DEFAULT_SETTINGS.extraction.keySignals.extraStatusPatterns).toEqual([]);
    expect(DEFAULT_SETTINGS.extraction.goals.extraTaskVerbs).toEqual([]);
    expect(DEFAULT_SETTINGS.extraction.goals.extraScopeChangeWords).toEqual([]);
  });

  it("loadSettings returns valid config with extraction defaults", async () => {
    const s = await loadSettings();
    // Don't assert on boolean fields that may differ per environment
    expect(s.extraction).toBeDefined();
    expect(s.extraction.references.enabled).toBe(true);
    expect(s.extraction.keySignals.enabled).toBe(true);
    expect(s.extraction.goals.enabled).toBe(true);
  });
});
