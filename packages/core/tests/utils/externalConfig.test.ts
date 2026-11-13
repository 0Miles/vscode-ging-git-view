import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import {
  applyExternalConfig,
  generateExternalConfig,
  parseExternalConfig,
  readExternalConfig,
  serializeExternalConfig
} from "@ging/core/backend/utils/externalConfig";

import { makeTempDir, rmrf } from "@ging/core/tests/helpers";

describe("readExternalConfig", () => {
  const folder = () => {
    const dir = makeTempDir("ging-external-config-");
    onTestFinished(() => rmrf(dir));
    return dir;
  };

  it("reads the shared settings committed in a repo", () => {
    const repo = folder();
    fs.mkdirSync(path.join(repo, ".vscode"));
    fs.writeFileSync(
      path.join(repo, ".vscode", "ging-git-view.json"),
      '{ "hiddenRemotes": ["upstream"] }'
    );
    expect(readExternalConfig(repo)).toEqual({ hiddenRemotes: ["upstream"] });
  });

  it("answers null for a repo without them", () => {
    expect(readExternalConfig(folder())).toBeNull();
  });
});

describe("generateExternalConfig", () => {
  it("includes only the shareable fields that are set", () => {
    expect(
      generateExternalConfig({
        columnWidths: null,
        commitOrdering: "topo",
        showRemoteBranches: false,
        hiddenRemotes: ["upstream"],
        customName: "Personal Name" // not shared
      })
    ).toEqual({ commitOrder: "topo", showRemoteBranches: false, hiddenRemotes: ["upstream"] });
  });

  it("omits unset fields and empty hiddenRemotes", () => {
    expect(generateExternalConfig({ columnWidths: null, hiddenRemotes: [] })).toEqual({});
  });
});

describe("parseExternalConfig", () => {
  it("parses a valid config", () => {
    expect(parseExternalConfig('{"commitOrder":"date","showRemoteBranches":true}')).toEqual({
      commitOrder: "date",
      showRemoteBranches: true
    });
  });

  it("drops fields with the wrong type or invalid values", () => {
    const parsed = parseExternalConfig(
      '{"commitOrder":"bogus","showRemoteBranches":"yes","hiddenRemotes":["a",1]}'
    );
    expect(parsed).toEqual({}); // all three fields invalid → dropped
  });

  it("returns null for non-object or invalid JSON", () => {
    expect(parseExternalConfig("not json")).toBeNull();
    expect(parseExternalConfig("[1,2,3]")).toBeNull();
    expect(parseExternalConfig("42")).toBeNull();
  });
});

describe("applyExternalConfig", () => {
  it("merges config fields over the existing state", () => {
    const state = { columnWidths: null, commitOrdering: "date" as const, customName: "Mine" };
    const merged = applyExternalConfig({ commitOrder: "topo", hiddenRemotes: ["x"] }, state);
    expect(merged.commitOrdering).toBe("topo");
    expect(merged.hiddenRemotes).toEqual(["x"]);
    expect(merged.customName).toBe("Mine"); // untouched personal field
    expect(state.commitOrdering).toBe("date"); // original not mutated
  });
});

describe("serializeExternalConfig", () => {
  it("produces pretty JSON with a trailing newline that round-trips", () => {
    const config = { commitOrder: "topo" as const, hiddenRemotes: ["u"] };
    const text = serializeExternalConfig(config);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseExternalConfig(text)).toEqual(config);
  });
});
