import { describe, expect, it } from "vitest";

import { buildDesktopPage } from "@ging/desktop/page";
import { applyTheme, themeFor, type ThemeKind } from "@ging/desktop/theme";

const pageFor = (kind: ThemeKind, platform: NodeJS.Platform = "win32") =>
  new DOMParser().parseFromString(buildDesktopPage(themeFor(kind, platform)), "text/html");

describe("buildDesktopPage", () => {
  it("writes the theme's variables into the inline style of <html>", () => {
    const style = pageFor("dark").documentElement.style;
    expect(style.getPropertyValue("--vscode-editor-background")).toBe("#1f1f1f");
    // A value with quotes in it survives the attribute.
    expect(style.getPropertyValue("--vscode-font-family")).toBe(
      "'Segoe WPC', 'Segoe UI', sans-serif"
    );
  });

  it("marks <body> with the theme's kind", () => {
    expect(pageFor("light").body.className).toBe("vscode-light");
  });

  it("loads the stylesheet and the desktop bundle from the app", () => {
    const doc = pageFor("dark");
    expect(doc.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toBe("main.css");
    expect([...doc.scripts].map((s) => s.getAttribute("src"))).toEqual(["web.js"]);
  });
});

describe("applyTheme", () => {
  it("switches a page to another theme, keeping the body's other classes", () => {
    const doc = pageFor("dark");
    doc.body.classList.add("selection-background-color-exists");

    applyTheme(doc, themeFor("light", "win32"));

    expect(doc.documentElement.style.getPropertyValue("--vscode-editor-background")).toBe(
      "#ffffff"
    );
    expect([...doc.body.classList].toSorted()).toEqual([
      "selection-background-color-exists",
      "vscode-light"
    ]);
  });
});
