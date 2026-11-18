import { expect, test } from "@playwright/test";

import { desktopPage, hostSays, pageErrors, posted } from "./harness";

// The desktop window's own page (#393) in a real browser: the tab strip the
// main process lays the Tabs' views out below — so it must be exactly
// TAB_STRIP_HEIGHT tall, whatever it holds — and the Welcome page under it,
// whose prompts come up in the host prompt overlay. The host's half is played
// here, as in hostPrompt.spec.ts.

function tab(id: number, title: string, focused = false) {
  return { id, title, tooltip: `/repos/${title}`, focused, asking: false };
}

function windowState(
  tabs: ReturnType<typeof tab>[],
  notice: unknown = null,
  welcome: unknown = null,
  clone: unknown = null
) {
  return {
    command: "windowState",
    tabs,
    notice,
    welcome,
    clone,
    strings: { closeTab: "Close Tab" }
  };
}

let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = pageErrors(page);
  await page.goto(desktopPage("window"));
  await expect(page.locator("html")).toHaveAttribute("data-ging-entry", "ging-desktop-entry");
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("the tab strip is TAB_STRIP_HEIGHT tall along the top, its Tabs side by side", async ({
  page
}) => {
  // The protocol's constant, which the harness put on the page.
  const TAB_STRIP_HEIGHT = await page.evaluate(
    () => (globalThis as unknown as { harnessTabStripHeight: number }).harnessTabStripHeight
  );
  expect(TAB_STRIP_HEIGHT).toBeGreaterThan(0);
  const long = "a-repository-with-a-name-far-too-long-for-any-tab-in-the-strip";
  await hostSays(page, windowState([tab(1, "alpha"), tab(2, long, true), tab(3, "gamma")]));

  const strip = page.locator("#tabStrip");
  await expect(strip).toBeVisible();
  const box = (await strip.boundingBox())!;
  expect(box).toMatchObject({ x: 0, y: 0, height: TAB_STRIP_HEIGHT });
  expect(box.width).toBe(page.viewportSize()!.width);

  const tabs = await page.locator("#tabStrip .tab").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const title = el.querySelector(".tabTitle")!;
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        clipped: title.scrollWidth > title.clientWidth,
        closeInside: (() => {
          const c = el.querySelector(".tabClose")!.getBoundingClientRect();
          return c.left >= r.left && c.right <= r.right;
        })()
      };
    })
  );
  // In a row, each the strip's height, none overlapping the next; a long name
  // is cut short rather than pushing its close button out of its Tab.
  for (const [i, t] of tabs.entries()) {
    expect(t).toMatchObject({ top: 0, closeInside: true });
    expect(t.bottom).toBeLessThanOrEqual(TAB_STRIP_HEIGHT);
    if (i > 0) expect(t.left).toBeGreaterThanOrEqual(tabs[i - 1].right);
  }
  expect(tabs[1].clipped).toBe(true);
});

test("a Tab clicked, or its close button, is asked of the host", async ({ page }) => {
  await hostSays(page, windowState([tab(1, "alpha", true), tab(2, "beta")]));

  await page.locator("#tabStrip .tab", { hasText: "beta" }).click();
  await page.locator("#tabStrip .tab", { hasText: "alpha" }).hover();
  await page.locator("#tabStrip .tab", { hasText: "alpha" }).locator(".tabClose").click();

  expect(await posted(page)).toEqual([
    { command: "windowReady" },
    { command: "hostPromptReady" },
    { command: "focusTab", id: 2 },
    { command: "closeTab", id: 1 }
  ]);
});

const WELCOME = {
  recent: [
    { path: "/repos/beta", name: "beta", missing: false },
    {
      path: `/a/folder/${"very-deep/".repeat(20)}alpha`,
      name: "alpha",
      missing: true
    }
  ],
  strings: {
    openFolder: "Open Folder...",
    cloneRepo: "Clone Repository...",
    initRepo: "Initialize Repository...",
    recent: "Recent",
    noRecent: "Repositories you open are listed here.",
    missing: "Not found",
    forget: "Remove from Recent"
  }
};

test("the Welcome page offers its entries and the recent list, and asks the host for each", async ({
  page
}) => {
  await hostSays(page, windowState([], null, WELCOME));
  const welcome = page.locator("#welcome");
  await expect(welcome.getByRole("button", { name: "Open Folder..." })).toBeVisible();
  await expect(welcome.getByRole("button", { name: "Clone Repository..." })).toBeVisible();
  await expect(welcome.getByRole("button", { name: "Initialize Repository..." })).toBeVisible();

  // Each row on one line, inside the window: a long path is cut short rather
  // than pushing its remove button out, and a folder that is gone says so.
  const rows = await welcome.locator(".recentRepo").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const forget = el.querySelector(".recentForget")!.getBoundingClientRect();
      const pathEl = el.querySelector(".recentPath")!;
      return {
        oneLine: r.height < 40,
        forgetInside: forget.left >= r.left && forget.right <= r.right,
        clipped: pathEl.scrollWidth > pathEl.clientWidth,
        missing: el.querySelector(".recentMissing")?.textContent ?? null,
        inWindow: r.right <= el.ownerDocument.documentElement.clientWidth
      };
    })
  );
  expect(rows).toEqual([
    { oneLine: true, forgetInside: true, clipped: false, missing: null, inWindow: true },
    { oneLine: true, forgetInside: true, clipped: true, missing: "Not found", inWindow: true }
  ]);
  await expect(welcome.locator(".recentMissing")).toBeVisible();

  await welcome.getByRole("button", { name: "Open Folder..." }).click();
  await welcome.getByRole("button", { name: "Clone Repository..." }).click();
  await welcome.getByRole("button", { name: "Initialize Repository..." }).click();
  await welcome.locator(".recentOpen", { hasText: "beta" }).click();
  await welcome.locator(".recentRepo", { hasText: "alpha" }).locator(".recentForget").click();

  expect((await posted(page)).slice(2)).toEqual([
    { command: "openFolder" },
    { command: "cloneRepo" },
    { command: "initRepo" },
    { command: "openRecent", path: "/repos/beta" },
    { command: "forgetRecent", path: WELCOME.recent[1].path }
  ]);
});

test("with no Tab, the Welcome page fills the window, and asks in the host prompt overlay", async ({
  page
}) => {
  await hostSays(
    page,
    windowState([], { title: "Unable to load GING", detail: "Cannot open /nowhere." })
  );
  await expect(page.locator("#tabStrip")).toBeHidden();
  const welcome = page.locator("#welcome");
  await expect(welcome.locator("h2")).toHaveText("Unable to load GING");
  expect(await welcome.boundingBox()).toMatchObject({ x: 0, y: 0, ...page.viewportSize() });

  await hostSays(page, {
    command: "hostPrompt",
    id: 1,
    prompt: { kind: "input", prompt: "GING: https://example.com", password: true },
    labels: { ok: "OK", cancel: "Cancel" }
  });
  const overlay = page.locator("#hostPrompt");
  await expect(overlay).toBeVisible();
  await expect(page.locator("#hostPromptInput")).toBeFocused();
  await page.keyboard.type("s3cret");
  await page.keyboard.press("Enter");
  await expect(overlay).toBeHidden();

  expect(await posted(page, "hostPromptAnswer")).toEqual([
    { command: "hostPromptAnswer", id: 1, answer: "s3cret" }
  ]);
});

test("a clone running stands over the Welcome page, its progress drawn, and asks the host to cancel it", async ({
  page
}) => {
  const clone = {
    title: `Cloning https://example.com/${"long-name/".repeat(12)}app.git`,
    folder: "into /work/app",
    stage: "Connecting...",
    percent: null,
    cancelling: false,
    cancel: "Cancel"
  };
  await hostSays(page, windowState([], null, WELCOME, clone));
  const panel = page.locator("#clonePanel");
  await expect(panel).toBeVisible();
  // Over the whole Welcome page, which takes no clicks under it.
  expect(await panel.boundingBox()).toMatchObject({ x: 0, y: 0, ...page.viewportSize() });
  await expect(page.locator("#welcome")).toHaveAttribute("inert", "");
  const cancel = panel.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  // A long URL wraps inside the box rather than out of the window.
  const box = (await panel.locator(".cloneBox").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await hostSays(
    page,
    windowState([], null, WELCOME, {
      ...clone,
      stage: "Receiving objects:  50% (5/10)",
      percent: 50
    })
  );
  await expect(panel.locator(".cloneStage")).toHaveText("Receiving objects:  50% (5/10)");
  const [bar, fill] = await Promise.all([
    panel.locator(".cloneBar").boundingBox(),
    panel.locator(".cloneBarFill").boundingBox()
  ]);
  expect(Math.abs(fill!.width - bar!.width / 2)).toBeLessThanOrEqual(1);

  await cancel.click();
  expect((await posted(page)).at(-1)).toEqual({ command: "cancelClone" });

  await hostSays(page, windowState([], null, WELCOME));
  await expect(panel).toBeHidden();
  await expect(page.locator("#welcome")).not.toHaveAttribute("inert", "");
});
