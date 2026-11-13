import { describe, expect, it } from "vitest";

import { buildGraphViewState } from "@ging/core/extension/graphViewState";
import { buildDesktopPage } from "@ging/desktop/page";
import { applyTheme, themeFor, type ThemeKind } from "@ging/desktop/theme";
import { getWebviewLocalizedStrings } from "@ging/webview/webviewL10n";

import { fakePorts } from "@ging/core/tests/helpers";

/** A view state as core builds one, from a fake host's settings. */
function makeViewState() {
  const { config, repoSource } = fakePorts().ports;
  return buildGraphViewState({
    config,
    repoSource,
    extensionState: { getDialogMemory: () => ({}), isAvatarStorageAvailable: () => true }
  });
}

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
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

describe("buildDesktopPage for a repository", () => {
  const viewState = { ...makeViewState(), graphColours: ["#0085d9", "#d9008f"] };
  const strings = { ...getWebviewLocalizedStrings((key) => key), find: "Find <it>" };
  const graphPage = () =>
    parse(
      buildDesktopPage(themeFor("dark", "win32"), {
        graph: { viewState, l10n: strings, nonce: "n0nce" }
      })
    );

  it("lays out the graph's markup, with its strings, for the bundle to start on", () => {
    const doc = graphPage();
    expect(doc.getElementById("commitTable")).not.toBeNull();
    expect(doc.getElementById("findBtn")?.getAttribute("title")).toBe("Find <it>");
  });

  it("hands the bundle the view state and strings in scripts only its nonce allows", () => {
    const doc = graphPage();
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!;
    expect(csp.getAttribute("content")).toContain("script-src 'self' 'nonce-n0nce'");

    const inline = [...doc.scripts].filter((s) => !s.hasAttribute("src"));
    expect(inline.map((s) => s.getAttribute("nonce"))).toEqual(["n0nce", "n0nce"]);
    const globals: Record<string, unknown> = {};
    for (const script of inline)
      new Function("window", script.text.replace(/^var /, "window."))(globals);
    expect(globals.viewState).toEqual(viewState);
    expect(globals.l10n).toEqual(strings);
    // The bundle comes last, once both are set.
    expect([...doc.scripts].at(-1)?.getAttribute("src")).toBe("web.js");
  });

  it("gives each graph colour its variable", () => {
    const doc = graphPage();
    expect(doc.body.style.getPropertyValue("--git-graph-color1")).toBe("#d9008f");
    expect(doc.head.querySelector("style:last-of-type")?.textContent).toContain(
      '[data-color="1"]{--git-graph-color:var(--git-graph-color1);}'
    );
  });

  it("keeps a repository's text from closing the script it sits in", () => {
    const html = buildDesktopPage(themeFor("dark", "win32"), {
      graph: {
        viewState: { ...viewState, lastActiveRepo: "/r/</script><b>x" },
        l10n: strings,
        nonce: "n"
      }
    });
    expect(html).not.toContain("</script><b>x");
    expect(parse(html).querySelector("b")).toBeNull();
  });
});

describe("buildDesktopPage with nothing to show", () => {
  it("says why, in the page's own words, and starts no graph", () => {
    const doc = parse(
      buildDesktopPage(themeFor("light", "win32"), {
        notice: { title: "Unable to load GING", detail: "Cannot open <C:\\x>." }
      })
    );
    expect(doc.querySelector("h2")?.textContent).toBe("Unable to load GING");
    expect(doc.querySelector("p")?.textContent).toBe("Cannot open <C:\\x>.");
    expect(doc.getElementById("commitTable")).toBeNull();
    expect([...doc.scripts].map((s) => s.getAttribute("src"))).toEqual(["web.js"]);
  });

  it("is empty when nothing was asked for", () => {
    const doc = parse(buildDesktopPage(themeFor("light", "win32"), { notice: null }));
    expect(doc.body.textContent?.trim()).toBe("");
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
