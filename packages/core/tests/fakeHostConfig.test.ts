import { describe, expect, it } from "vitest";

import { fakePorts } from "@ging/core/tests/helpers";

// `HostConfig.update` on the fake host (#397): it keeps what it is told, so a
// test can read back what was written, and it can be made to refuse.

describe("the fake host's config.update", () => {
  it("logs the write and keeps the value by its key", async () => {
    const { ports, calls, held } = fakePorts();

    await ports.config.update("ging-git-view.autoFetch.intervalMinutes", 5);

    expect(calls).toEqual([["config.update", "ging-git-view.autoFetch.intervalMinutes", 5]]);
    expect(held.settings).toEqual({ "ging-git-view.autoFetch.intervalMinutes": 5 });
  });

  it("keeps a copy, not the caller's object", async () => {
    const { ports, held } = fakePorts();
    const value = { date: true };

    await ports.config.update("ging-git-view.columnVisibility", value);
    value.date = false;

    expect(held.settings["ging-git-view.columnVisibility"]).toEqual({ date: true });
  });

  it("rejects, writing nothing, when told to refuse", async () => {
    const { ports, answers, held } = fakePorts();
    answers.updateRejects = "not a setting";

    await expect(ports.config.update("ging-git-view.nope", 1)).rejects.toThrow("not a setting");
    expect(held.settings).toEqual({});
  });
});
