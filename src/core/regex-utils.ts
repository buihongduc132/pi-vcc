/**
 * Shared regex hardening utilities for pi-vcc.
 * Prevents RegExp injection and ReDoS attacks.
 */

/**
 * Escape special regex characters in a string so it can be safely used in new RegExp().
 * This prevents RegExp injection when interpolating user-provided strings.
 */
export const escapeRegExp = (str: string): string => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

/**
 * Detect and reject regex patterns with catastrophic backtracking potential (ReDoS).
 * Throws if the pattern contains nested quantifiers or excessive complexity.
 *
 * Checks for:
 * - Nested quantifiers like (a+)+, (a*)+, (.+)+
 * - Alternation groups with outer quantifiers like (a|a)+, (a+|b+)+
 * - Deeply nested groups with quantifiers like ((a+))+
 * - Excessive pattern length (>500 chars)
 */
export const assertSafeComplexity = (pattern: string): void => {
  // Reject excessively long patterns
  if (pattern.length > 500) {
    throw new Error(`Regex pattern exceeds maximum length: ${pattern.length} > 500`);
  }

  // Try to compile to catch syntax errors first
  try {
    new RegExp(pattern);
  } catch {
    // Invalid regex syntax - don't enforce complexity on broken patterns
    return;
  }

  // Build a parse tree of groups with their quantifiers and contents
  const groups = parseGroups(pattern);

  for (const g of groups) {
    // Check 1: Group with outer quantifier AND inner quantifier content
    if (g.hasOuterQuantifier && g.hasInnerQuantifier) {
      throw new Error("Regex pattern has unsafe complexity (nested quantifiers detected)");
    }

    // Check 2: Group with outer quantifier AND alternation
    if (g.hasOuterQuantifier && g.hasAlternation) {
      throw new Error("Regex pattern has unsafe complexity (alternation with quantifiers)");
    }

    // Check 3: Group with outer quantifier AND nested sub-groups
    if (g.hasOuterQuantifier && g.hasNestedGroups) {
      throw new Error("Regex pattern has unsafe complexity (group with quantifier contains nested groups)");
    }
  }
};

interface GroupInfo {
  content: string;
  hasOuterQuantifier: boolean;
  hasInnerQuantifier: boolean;
  hasAlternation: boolean;
  hasNestedGroups: boolean;
}

/**
 * Parse all top-level groups from a regex pattern and analyze their properties.
 */
const parseGroups = (pattern: string): GroupInfo[] => {
  const groups: GroupInfo[] = [];
  let i = 0;

  while (i < pattern.length) {
    if (pattern[i] === "\\") {
      i += 2; // skip escape
      continue;
    }

    if (pattern[i] === "(") {
      const groupResult = extractGroup(pattern, i);
      if (groupResult) {
        groups.push(groupResult.info);
        i = groupResult.end;
        continue;
      }
    }
    i++;
  }

  return groups;
};

interface GroupResult {
  info: GroupInfo;
  end: number; // index after closing )
}

/**
 * Extract a group starting at position `start` (which points to `(`).
 * Returns group info and the position after the closing `)`.
 */
const extractGroup = (pattern: string, start: number): GroupResult | null => {
  let depth = 1;
  let i = start + 1;
  let hasNestedGroups = false;
  let hasAlternation = false;
  let hasInnerQuantifier = false;
  const contentChars: string[] = [];

  while (i < pattern.length && depth > 0) {
    const ch = pattern[i];

    if (ch === "\\") {
      contentChars.push(ch);
      if (i + 1 < pattern.length) {
        contentChars.push(pattern[i + 1]);
      }
      i += 2;
      continue;
    }

    if (ch === "(") {
      depth++;
      hasNestedGroups = true;
      contentChars.push(ch);
      i++;
      continue;
    }

    if (ch === ")") {
      depth--;
      if (depth === 0) {
        // Found the closing paren
        const content = contentChars.join("");
        const nextIdx = i + 1;
        const nextChar = nextIdx < pattern.length ? pattern[nextIdx] : "";
        const hasOuterQuantifier = /[+*{]/.test(nextChar);

        // Check content for inner quantifiers and alternation at depth 0 of this group
        // (not inside nested sub-groups)
        const topLevelAnalysis = analyzeGroupContent(content);

        return {
          info: {
            content,
            hasOuterQuantifier,
            hasInnerQuantifier: topLevelAnalysis.hasQuantifier,
            hasAlternation: topLevelAnalysis.hasAlternation,
            hasNestedGroups,
          },
          end: i + 1,
        };
      }
      contentChars.push(ch);
      i++;
      continue;
    }

    contentChars.push(ch);

    if (depth === 1 && /[+*]/.test(ch)) {
      hasInnerQuantifier = true;
    }
    if (depth === 1 && ch === "|") {
      hasAlternation = true;
    }
    // Check for {n,m} quantifiers at depth 1
    if (depth === 1 && ch === "{") {
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== "}") {
        j++;
        if (j - i > 10) break; // not a real quantifier
      }
      if (j < pattern.length && pattern[j] === "}") {
        hasInnerQuantifier = true;
      }
    }

    i++;
  }

  return null; // unclosed group
};

interface ContentAnalysis {
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

/**
 * Analyze group content at the top level (not inside nested sub-groups).
 */
const analyzeGroupContent = (content: string): ContentAnalysis => {
  let depth = 0;
  let hasQuantifier = false;
  let hasAlternation = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (ch === "\\") {
      i++; // skip escaped char
      continue;
    }

    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }

    if (depth === 0) {
      if (/[+*]/.test(ch)) {
        hasQuantifier = true;
      }
      if (ch === "|") {
        hasAlternation = true;
      }
      if (ch === "{") {
        // Check if it's a quantifier like {n,m}
        let j = i + 1;
        let isQuant = false;
        while (j < content.length && content[j] !== "}") {
          if (!/[0-9,]/.test(content[j])) break;
          j++;
          if (j - i > 10) break;
        }
        if (j < content.length && content[j] === "}") {
          isQuant = true;
        }
        if (isQuant) {
          hasQuantifier = true;
        }
      }
    }
  }

  return { hasQuantifier, hasAlternation };
};
