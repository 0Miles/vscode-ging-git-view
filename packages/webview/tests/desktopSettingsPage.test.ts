import { describe, expect, it, vi } from "vitest";

import type { SettingsPageState } from "@ging/webview/desktop/settings/protocol";

import { createVscodeMock } from "./setup";
import { startDesktop } from "./startDesktop";

// The desktop entry on a settings page (#397): one row per setting the host
// handed it, each change sent as it is made, and the host's answer shown.
// The webview E2E (e2e/webview/settings.spec.ts) drives the same page in a
// real browser over the whole schema.

const STATE: SettingsPageState = {
  settings: [
    {
      key: "ging-git-view.dates.format",
      title: "Dates: Format",
      description: "How dates are shown.",
      markdown: false,
      type: "string",
      enum: ["Date & Time", "Relative"],
      default: "Date & Time",
      value: "Relative"
    },
    {
      key: "ging-git-view.dates.customFormat",
      title: "Dates: Custom Format",
      description:
        "Used when [`Dates: Format`](#ging-git-view.dates.format) is <b>custom</b>. [Docs](https://example.com/d) [x](javascript:alert(1))",
      markdown: true,
      type: "string",
      default: "DD MMM YYYY",
      value: "DD MMM YYYY"
    },
    {
      key: "ging-git-view.show.tags",
      title: "Show: Tags",
      description: "Show tags.",
      markdown: false,
      type: "boolean",
      default: true,
      value: true
    },
    {
      key: "ging-git-view.graph.palette",
      title: "Graph: Palette",
      description: "Colours.",
      markdown: false,
      type: "array",
      default: ["#000000"],
      value: ["#000000"]
    }
  ],
  theme: "system",
  strings: {
    title: "Settings",
    themeTitle: "Theme",
    themeDescription: "Colours.",
    themeSystem: "Follow System",
    themeDark: "Dark",
    themeLight: "Light",
    editAsJson: "Edit as JSON.",
    invalidJson: "Not JSON.",
    notSaved: "Not saved. {0}"
  }
};

async function load(state: SettingsPageState | undefined) {
  vi.resetModules();
  const mock = createVscodeMock();
  (globalThis as { settingsPage?: SettingsPageState }).settingsPage = state;
  document.documentElement.dataset.gingPage = "settings";
  document.body.innerHTML = '<main id="settings"></main>';
  await startDesktop();
  return mock;
}

const control = <T extends HTMLElement>(key: string) =>
  document
    .getElementById(key)!
    .querySelector<T>(".settingControl input, .settingControl select, .settingControl textarea")!;

const change = (element: HTMLElement) => element.dispatchEvent(new Event("change"));

/** The host telling the page to show setting `key`'s row. */
const reveal = (key: string) =>
  window.dispatchEvent(new MessageEvent("message", { data: { command: "revealSetting", key } }));

describe("the desktop entry on a settings page", () => {
  it("builds one row per setting, its id the key, showing the value the host holds", async () => {
    await load(STATE);
    expect(Array.from(document.querySelectorAll(".settingRow"), (row) => row.id)).toEqual(
      STATE.settings.map((s) => s.key)
    );
    expect(control<HTMLSelectElement>("ging-git-view.dates.format").selectedOptions[0].text).toBe(
      "Relative"
    );
    expect(control<HTMLInputElement>("ging-git-view.show.tags").checked).toBe(true);
    expect(JSON.parse(control<HTMLTextAreaElement>("ging-git-view.graph.palette").value)).toEqual([
      "#000000"
    ]);
  });

  it("brings the row of the setting its URL names into view, and no other", async () => {
    const scrolled: string[] = [];
    // jsdom lays nothing out, so it has no scrollIntoView of its own.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    try {
      window.history.replaceState(null, "", "?setting=ging-git-view.show.tags");
      await load(STATE);
      expect(scrolled).toEqual(["ging-git-view.show.tags"]);

      scrolled.length = 0;
      window.history.replaceState(null, "", "?setting=ging-theme");
      await load(STATE);
      expect(scrolled).toEqual([]);
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("shows the row the host reveals, marked, leaving a draft typed in another row as it is", async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    try {
      await load(STATE);
      // Typed, but not JSON, so never sent: only the page holds it.
      const palette = control<HTMLTextAreaElement>("ging-git-view.graph.palette");
      palette.value = "[oops";
      change(palette);

      reveal("ging-git-view.dates.format");
      reveal("ging-git-view.show.tags");

      const marked = Array.from(document.querySelectorAll(".settingRow.revealed"), (r) => r.id);
      expect(marked).toEqual(["ging-git-view.show.tags"]);
      expect(scrolled.at(-1)).toBe("ging-git-view.show.tags");
      expect(palette.value).toBe("[oops");
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("renders a markdown description's link to another setting as a link to its row, and escapes the rest", async () => {
    await load(STATE);
    const description = document.getElementById("ging-git-view.dates.customFormat")!;
    const links = Array.from(description.querySelectorAll("a"));
    expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("target")])).toEqual([
      ["#ging-git-view.dates.format", null],
      // Out to the user's browser, by way of the host; anything else is text.
      ["https://example.com/d", "_blank"]
    ]);
    expect(links[0].querySelector("code")?.textContent).toBe("Dates: Format");
    expect(description.querySelector("b")).toBeNull();
    expect(description.textContent).toContain("<b>custom</b>");
  });

  it("sends each change as it is made", async () => {
    const mock = await load(STATE);
    const format = control<HTMLSelectElement>("ging-git-view.dates.format");
    format.value = "0";
    change(format);
    const tags = control<HTMLInputElement>("ging-git-view.show.tags");
    tags.checked = false;
    change(tags);

    expect(mock.sentMessages).toEqual([
      { command: "updateSetting", key: "ging-git-view.dates.format", value: "Date & Time" },
      { command: "updateSetting", key: "ging-git-view.show.tags", value: false }
    ]);
  });

  it("sends no JSON that does not parse, and says so", async () => {
    const mock = await load(STATE);
    const palette = control<HTMLTextAreaElement>("ging-git-view.graph.palette");
    palette.value = "[oops";
    change(palette);

    expect(mock.sentMessages).toEqual([]);
    const error = document
      .getElementById("ging-git-view.graph.palette")!
      .querySelector<HTMLElement>(".settingError")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Not JSON.");
  });

  it("shows the value the host answers with, and why it was not saved", async () => {
    await load(STATE);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          command: "settingUpdated",
          key: "ging-git-view.show.tags",
          value: false,
          error: "This setting does not allow that value."
        }
      })
    );

    expect(control<HTMLInputElement>("ging-git-view.show.tags").checked).toBe(false);
    const error = document
      .getElementById("ging-git-view.show.tags")!
      .querySelector<HTMLElement>(".settingError")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Not saved. This setting does not allow that value.");
  });

  it("sends the theme chosen", async () => {
    const mock = await load(STATE);
    const theme = document.querySelector<HTMLSelectElement>("#ging-theme select")!;
    expect(theme.value).toBe("system");
    theme.value = "light";
    change(theme);
    expect(mock.sentMessages).toEqual([{ command: "setTheme", theme: "light" }]);
  });

  it("reports a settings page served without its settings", async () => {
    const mock = await load(undefined);
    expect(mock.sentMessages).toEqual([
      {
        command: "reportError",
        report: expect.objectContaining({ message: expect.stringContaining("settings page") })
      }
    ]);
  });
});
