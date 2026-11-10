/** A `keyboardShortcut.*` setting value matching "CTRL/CMD + <A-Z>". */
const KEYBINDING_REGEXP = /^CTRL\/CMD \+ [A-Z]$/;

/**
 * Normalise a `keyboardShortcut.*` setting value: "UNASSIGNED" → null (the
 * shortcut is disabled), "CTRL/CMD + X" → "x" (the lowercase key char), and
 * anything else → the supplied default key char.
 */
export function normalizeKeybinding(value: string, defaultKey: string): string | null {
  if (value === "UNASSIGNED") return null;
  if (KEYBINDING_REGEXP.test(value)) return value.charAt(value.length - 1).toLowerCase();
  return defaultKey;
}
