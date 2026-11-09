import { describe, expect, it } from "vitest";

import { applyDialogMemory, extractDialogMemory } from "@/webview/dialogMemory";

describe("applyDialogMemory", () => {
  it("returns the inputs unchanged when there is no memory", () => {
    const inputs: DialogInput[] = [
      { type: "checkbox", name: "Squash", value: false, remember: true }
    ];
    expect(applyDialogMemory(inputs, undefined)).toBe(inputs);
  });

  it("applies a remembered checkbox value", () => {
    const inputs: DialogInput[] = [
      { type: "checkbox", name: "No Fast Forward", value: false, remember: true }
    ];
    const [out] = applyDialogMemory(inputs, { "No Fast Forward": "checked" });
    expect(out).toMatchObject({ type: "checkbox", value: true });
    // Original input is not mutated.
    expect(inputs[0]).toMatchObject({ value: false });
  });

  it("applies a remembered select value only when it matches an option", () => {
    const inputs: DialogInput[] = [
      {
        type: "select",
        name: "Mode",
        default: "mixed",
        options: [
          { name: "Soft", value: "soft" },
          { name: "Mixed", value: "mixed" },
          { name: "Hard", value: "hard" }
        ],
        remember: true
      }
    ];
    expect(applyDialogMemory(inputs, { Mode: "hard" })[0]).toMatchObject({ default: "hard" });
    // A stale/foreign value is ignored, falling back to the caller's default.
    expect(applyDialogMemory(inputs, { Mode: "bogus" })[0]).toMatchObject({ default: "mixed" });
  });

  it("ignores inputs not flagged remember and free-text inputs", () => {
    const inputs: DialogInput[] = [
      { type: "text-ref", name: "Branch", default: "feature" },
      { type: "checkbox", name: "Force", value: false }
    ];
    const out = applyDialogMemory(inputs, { Branch: "other", Force: "checked" });
    expect(out[0]).toMatchObject({ default: "feature" });
    expect(out[1]).toMatchObject({ value: false });
  });
});

describe("extractDialogMemory", () => {
  it("collects only remember-flagged inputs, keyed by name", () => {
    const inputs: DialogInput[] = [
      { type: "select", name: "Parent", options: [], default: "1" },
      { type: "checkbox", name: "No Commit", value: false, remember: true },
      { type: "checkbox", name: "Record Origin", value: false, remember: true }
    ];
    const values = ["2", "checked", "unchecked"];
    expect(extractDialogMemory(inputs, values)).toEqual({
      "No Commit": "checked",
      "Record Origin": "unchecked"
    });
  });

  it("returns an empty object when nothing is remembered", () => {
    const inputs: DialogInput[] = [{ type: "text", name: "Name", default: "", placeholder: null }];
    expect(extractDialogMemory(inputs, [""])).toEqual({});
  });
});
