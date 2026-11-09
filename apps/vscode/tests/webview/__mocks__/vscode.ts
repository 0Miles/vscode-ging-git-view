import * as fs from "node:fs";
import * as path from "node:path";

// Load English translations from bundle.l10n.json
const l10nPath = path.resolve(__dirname, "../../../l10n/bundle.l10n.json");
const translations: Record<string, string> = JSON.parse(fs.readFileSync(l10nPath, "utf8"));

export const l10n = {
  t: (
    key: string,
    ...args: Array<string | number | boolean | Record<string, string | number | boolean>>
  ): string => {
    const template = translations[key] || key;

    // Handle object arguments (named parameters)
    if (args.length === 1 && typeof args[0] === "object" && !Array.isArray(args[0])) {
      return template.replace(/\{(\w+)\}/g, (_, name: string) => {
        const value = (args[0] as Record<string, string | number | boolean>)[name];
        return value !== undefined ? String(value) : `{${name}}`;
      });
    }

    // Handle positional arguments {0}, {1}, etc.
    if (args.length > 0) {
      return template.replace(/\{(\d+)\}/g, (_, index) => {
        const value = args[parseInt(index, 10)];
        return value !== undefined ? String(value) : `{${index}}`;
      });
    }

    return template;
  },
  uri: undefined
};

// Minimal `vscode.Uri` stand-in: enough for URI construction/inspection in
// pure logic under test (scheme, path, fsPath, query, `.with()`, `.toString()`).
type UriParts = {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
};

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  private constructor(parts: UriParts) {
    this.scheme = parts.scheme;
    this.authority = parts.authority;
    this.path = parts.path;
    this.query = parts.query;
    this.fragment = parts.fragment;
  }

  static file(fsPath: string): Uri {
    return new Uri({ scheme: "file", authority: "", path: fsPath, query: "", fragment: "" });
  }

  get fsPath(): string {
    return this.path;
  }

  with(change: Partial<UriParts>): Uri {
    return new Uri({
      scheme: change.scheme ?? this.scheme,
      authority: change.authority ?? this.authority,
      path: change.path ?? this.path,
      query: change.query ?? this.query,
      fragment: change.fragment ?? this.fragment
    });
  }

  toString(): string {
    const q = this.query ? `?${this.query}` : "";
    const f = this.fragment ? `#${this.fragment}` : "";
    return `${this.scheme}://${this.authority}${this.path}${q}${f}`;
  }
}
