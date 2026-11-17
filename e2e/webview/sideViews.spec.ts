import { expect, type Page, test } from "@playwright/test";

import { harnessPage } from "./harness";

// The desktop side views' column (#399) in a real browser: the region ADR-0031
// drew for it — the window's left edge, full height, fixed, owning `body`'s
// `padding-left` — and the graph's two window-wide things giving up its width
// on their left. jsdom lays nothing out, so this is where that is held. The
// host's half is played here, as in hostPrompt.spec.ts.

/** A message from the host, delivered as the desktop preload delivers one. */
async function hostSays(page: Page, data: unknown) {
  await page.evaluate((message) => {
    globalThis.dispatchEvent(new MessageEvent("message", { data: message }));
  }, data);
}

const leaf = (branch: string, isHead = false) => ({
  type: "leaf",
  branch,
  name: branch,
  isHead,
  isRemote: false,
  isMerged: false,
  isInactive: false,
  isHidable: false,
  isCleanupCandidate: false
});

/** The side views' words: each its own key, which is all the layout needs. */
const STRINGS = Object.fromEntries(
  [
    "branches",
    "remotes",
    "groupRemote",
    "groupLocal",
    "noBranches",
    "noRemotes",
    "more",
    "showAll",
    "refresh",
    "addRemote"
  ].map((key) => [key, key])
);

/** A side-view state (SideViewStateMessage in
 *  packages/webview/src/desktop/sideViews/protocol.ts), on the repository and
 *  with the menu settings the harness's graph has. */
function sideViewState(page: Page, filter: string[] = []) {
  return page.evaluate(
    ({ roots, filter, strings }) => {
      const { viewState } = globalThis as unknown as {
        viewState: { lastActiveRepo: string; contextMenuActionsVisibility: unknown };
      };
      return {
        command: "sideViewState",
        repo: viewState.lastActiveRepo,
        branches: {
          roots,
          rows: {},
          filter,
          toggles: {
            showRemoteBranches: true,
            showInactiveBranches: true,
            showMergedBranches: true
          }
        },
        remotes: [],
        cmv: viewState.contextMenuActionsVisibility,
        strings
      };
    },
    { roots: [leaf("master", true), leaf("develop")], filter, strings: STRINGS }
  );
}

/** What the page posted under `command`, in order. */
function posted(page: Page, command: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    (wanted) =>
      (
        globalThis as unknown as { harnessRequests: Record<string, unknown>[] }
      ).harnessRequests.filter((m) => m.command === wanted),
    command
  );
}

let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto(harnessPage("desktop"));
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(3);
  // The page said it listens, so the host may send the views' state.
  expect(await posted(page, "sideViewReady")).toHaveLength(1);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("the side views are a fixed column down the window's left edge, and the graph starts past it", async ({
  page
}) => {
  await hostSays(page, await sideViewState(page));
  const column = page.locator("#sideViews");
  await expect(column.locator('[data-ref="develop"]')).toBeVisible();

  const box = (await column.boundingBox())!;
  const width = await page.evaluate(() =>
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--ging-side-view-width")
    )
  );
  expect(width).toBeGreaterThan(0);
  expect(box).toEqual({ x: 0, y: 0, width, height: 700 });
  expect(await column.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");

  // `body` gives the column its width; the graph and its frozen header begin
  // where the column ends.
  expect(await page.evaluate(() => getComputedStyle(document.body).paddingLeft)).toBe(`${width}px`);
  expect((await page.locator("#controls").boundingBox())!.x).toBe(width);
  expect((await page.locator("#commitTable").boundingBox())!.x).toBeGreaterThanOrEqual(width);

  // Scrolling the graph leaves the column where it is: the graph keeps the
  // document's scroll.
  await page.evaluate(() => {
    document.body.style.minHeight = "3000px";
    window.scrollTo(0, 500);
  });
  expect((await column.boundingBox())!.y).toBe(0);
});

test("the docked Commit Details View and the scroll shadow give up the column's width on their left", async ({
  page
}) => {
  const width = await page.evaluate(() =>
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--ging-side-view-width")
    )
  );
  // The two as the graph shows them: classes it sets, read through the
  // stylesheets the page has.
  const edges = await page.evaluate(() => {
    const docked = document.createElement("div");
    docked.id = "commitDetails";
    docked.className = "docked";
    document.body.appendChild(docked);
    const shadow = document.getElementById("scrollShadow")!;
    shadow.classList.add("active");
    const read = (el: HTMLElement) => {
      const { left, right } = el.getBoundingClientRect();
      return { left, right };
    };
    return { docked: read(docked), shadow: read(shadow) };
  });
  expect(edges.docked).toEqual({ left: width, right: 1200 });
  expect(edges.shadow).toEqual({ left: width, right: 1200 });
});

test("a click on a branch asks the host for the filter it makes", async ({ page }) => {
  await hostSays(page, await sideViewState(page));
  await page.locator('#sideViews [data-ref="develop"]').click();

  await expect
    .poll(() => posted(page, "sideViewSetFilter"))
    .toEqual([
      {
        command: "sideViewSetFilter",
        repo: expect.any(String),
        branches: ["develop"]
      }
    ]);
  await expect(page.locator('#sideViews [data-ref="develop"]')).toHaveAttribute(
    "aria-selected",
    "true"
  );
});
