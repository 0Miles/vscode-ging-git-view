import { describe, expect, it } from "vitest";

import { readThemeChoice, writeThemeChoice } from "@ging/desktop/themeChoice";

import { fakeStorage } from "@ging/core/tests/helpers";

// The theme the user chose (#397), kept in HostStorage's global tier so the
// next launch opens in it.

describe("the theme choice", () => {
  it("is the system's until one is made", () => {
    expect(readThemeChoice(fakeStorage().open().global)).toBe("system");
  });

  it("is what was chosen, in a later session too", async () => {
    const storage = fakeStorage();
    await writeThemeChoice(storage.open().global, "light");
    expect(readThemeChoice(storage.open().global)).toBe("light");
  });

  it("goes back to the system's for something that is not a choice", async () => {
    const store = fakeStorage().open().global;
    await store.update("desktopTheme", "solarized");
    expect(readThemeChoice(store)).toBe("system");
  });
});
