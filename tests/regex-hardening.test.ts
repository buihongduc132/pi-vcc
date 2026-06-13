import { describe, expect, it } from "vitest";
import { escapeRegExp, assertSafeComplexity } from "../src/core/regex-utils";

describe("escapeRegExp", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegExp("foo.bar")).toBe("foo\\.bar");
    expect(escapeRegExp("foo*bar")).toBe("foo\\*bar");
    expect(escapeRegExp("foo+bar")).toBe("foo\\+bar");
    expect(escapeRegExp("foo?bar")).toBe("foo\\?bar");
    expect(escapeRegExp("foo$bar")).toBe("foo\\$bar");
    expect(escapeRegExp("foo^bar")).toBe("foo\\^bar");
    expect(escapeRegExp("foo(bar")).toBe("foo\\(bar");
    expect(escapeRegExp("foo)bar")).toBe("foo\\)bar");
    expect(escapeRegExp("foo[bar")).toBe("foo\\[bar");
    expect(escapeRegExp("foo]bar")).toBe("foo\\]bar");
    expect(escapeRegExp("foo{bar")).toBe("foo\\{bar");
    expect(escapeRegExp("foo}bar")).toBe("foo\\}bar");
    expect(escapeRegExp("foo|bar")).toBe("foo\\|bar");
    expect(escapeRegExp("foo\\bar")).toBe("foo\\\\bar");
  });

  it("handles strings with multiple metacharacters", () => {
    expect(escapeRegExp("file.ts")).toBe("file\\.ts");
    expect(escapeRegExp("a*b+c?")).toBe("a\\*b\\+c\\?");
    expect(escapeRegExp("(test)[1]{2}")).toBe("\\(test\\)\\[1\\]\\{2\\}");
  });

  it("leaves plain strings unchanged", () => {
    expect(escapeRegExp("hello")).toBe("hello");
    expect(escapeRegExp("test123")).toBe("test123");
    expect(escapeRegExp("")).toBe("");
  });

  it("escapes special sequences", () => {
    expect(escapeRegExp("\\d")).toBe("\\\\d");
    expect(escapeRegExp("\\w")).toBe("\\\\w");
    expect(escapeRegExp("\\s")).toBe("\\\\s");
  });
});

describe("assertSafeComplexity", () => {
  it("accepts simple patterns", () => {
    expect(() => assertSafeComplexity("foo")).not.toThrow();
    expect(() => assertSafeComplexity("foo.*bar")).not.toThrow();
    expect(() => assertSafeComplexity("\\d+")).not.toThrow();
    expect(() => assertSafeComplexity("[a-z]+")).not.toThrow();
    expect(() => assertSafeComplexity("(foo|bar)")).not.toThrow();
  });

  it("rejects nested quantifiers (ReDoS)", () => {
    expect(() => assertSafeComplexity("(a+)+")).toThrow(/complexity/i);
    expect(() => assertSafeComplexity("(a*)*")).toThrow(/complexity/i);
    expect(() => assertSafeComplexity("(a+)*")).toThrow(/complexity/i);
    expect(() => assertSafeComplexity("(a*)+")).toThrow(/complexity/i);
    expect(() => assertSafeComplexity("(.+)+")).toThrow(/complexity/i);
    expect(() => assertSafeComplexity("(a{2,})+")).toThrow(/complexity/i);
  });

  it("rejects catastrophic backtracking patterns", () => {
    expect(() => assertSafeComplexity("(a|a)+")).toThrow(/complexity/i);
    expect(() => assertSafeComplexity("(a|a)*")).toThrow(/complexity/i);
    expect(() => assertSafeComplexity("(a+|b+)+")).toThrow(/complexity/i);
  });

  it("rejects deeply nested groups with quantifiers", () => {
    expect(() => assertSafeComplexity("((a+))+")).toThrow(/complexity/i);
    expect(() => assertSafeComplexity("(((a+)))+")).toThrow(/complexity/i);
  });

  it("accepts patterns with quantifiers on non-groups", () => {
    expect(() => assertSafeComplexity("a+b+c+")).not.toThrow();
    expect(() => assertSafeComplexity("[a-z]+[0-9]*")).not.toThrow();
    expect(() => assertSafeComplexity("\\d+\\.\\d+")).not.toThrow();
  });

  it("handles invalid regex gracefully", () => {
    expect(() => assertSafeComplexity("(unclosed")).not.toThrow();
    expect(() => assertSafeComplexity("[unclosed")).not.toThrow();
  });

  it("rejects patterns with excessive length", () => {
    const longPattern = "a".repeat(1000);
    expect(() => assertSafeComplexity(longPattern)).toThrow(/length/i);
  });
});
