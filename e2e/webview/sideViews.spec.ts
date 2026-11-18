import { expect, type Page, test } from "@playwright/test";

import { harnessPage, harnessRepo, hostSays, pageErrors, posted, sideViewWidth } from "./harness";

// The desktop side views' column (#399) in a real browser: the region ADR-0031
// drew for it — the window's left edge, full height, fixed, owning `body`'s
// `padding-left` — and the graph's two window-wide things giving up its width
// on their left; and the Stash view (#400) sharing the column's height with
// the other two. jsdom lays nothing out, so this is where that is held. The
// host's half is played here, as in hostPrompt.spec.ts.

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
    "addRemote",
    "stashes",
    "noStashes"
  ].map((key) => [key, key])
);

/** `count` stashes, newest first, as the host lists them (SideViewStash). */
const stashList = (count: number) =>
  Array.from({ length: count }, (_, n) => ({
    id: `stash${n}`,
    selector: `stash@{${n}}`,
    message: `On master: work ${n}`,
    tooltip: `stash@{${n}}`
  }));

/** A side-view state (SideViewStateMessage in
 *  packages/webview/src/desktop/sideViews/protocol.ts), on the repository and
 *  with the menu settings the harness's graph has. */
function sideViewState(page: Page, filter: string[] = [], stashes = stashList(0)) {
  return page.evaluate(
    ({ roots, branchFilter, strings, stashRows }) => {
      const { viewState } = globalThis as unknown as {
        viewState: { lastActiveRepo: string; contextMenuActionsVisibility: unknown };
      };
      return {
        command: "sideViewState",
        repo: viewState.lastActiveRepo,
        filterSeq: 0,
        branches: {
          roots,
          rows: {},
          filter: branchFilter,
          toggles: {
            showRemoteBranches: true,
            showInactiveBranches: true,
            showMergedBranches: true
          }
        },
        remotes: [],
        stashes: stashRows,
        cmv: viewState.contextMenuActionsVisibility,
        strings
      };
    },
    {
      roots: [leaf("master", true), leaf("develop")],
      branchFilter: filter,
      strings: STRINGS,
      stashRows: stashes
    }
  );
}

let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = pageErrors(page);
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
  const width = await sideViewWidth(page);
  expect(width).toBeGreaterThan(0);
  expect(box).toEqual({ x: 0, y: 0, width, height: 700 });
  expect(await column.evaluate((el) => globalThis.getComputedStyle(el).position)).toBe("fixed");

  // `body` gives the column its width; the graph and its frozen header begin
  // where the column ends.
  expect(
    await page.evaluate(() => globalThis.getComputedStyle(globalThis.document.body).paddingLeft)
  ).toBe(`${width}px`);
  expect((await page.locator("#controls").boundingBox())!.x).toBe(width);
  expect((await page.locator("#commitTable").boundingBox())!.x).toBeGreaterThanOrEqual(width);

  // Scrolling the graph leaves the column where it is: the graph keeps the
  // document's scroll.
  await page.evaluate(() => {
    globalThis.document.body.style.minHeight = "3000px";
    globalThis.scrollTo(0, 500);
  });
  expect((await column.boundingBox())!.y).toBe(0);
});

test("the docked Commit Details View and the scroll shadow give up the column's width on their left", async ({
  page
}) => {
  const width = await sideViewWidth(page);
  // The two as the graph shows them: classes it sets, read through the
  // stylesheets the page has.
  const edges = await page.evaluate(() => {
    const { document } = globalThis;
    const docked = document.createElement("div");
    docked.id = "commitDetails";
    docked.className = "docked";
    document.body.appendChild(docked);
    const shadow = document.getElementById("scrollShadow")!;
    shadow.classList.add("active");
    return [docked, shadow].map((el) => {
      const { left, right } = el.getBoundingClientRect();
      return { left, right };
    });
  });
  expect(edges).toEqual([
    { left: width, right: 1200 },
    { left: width, right: 1200 }
  ]);

  // With the working tree panel out on the right too (#403), each keeps to
  // the space between the two columns.
  const between = await page.evaluate(() => {
    const { document } = globalThis;
    document.body.classList.add("workingTreeOpen");
    return ["commitDetails", "scrollShadow"].map((id) => {
      const { left, right } = document.getElementById(id)!.getBoundingClientRect();
      return { left, right };
    });
  });
  const panel = await page.evaluate(
    () =>
      globalThis.document.body.getBoundingClientRect().width -
      parseFloat(globalThis.getComputedStyle(globalThis.document.body).paddingRight)
  );
  expect(panel).toBeLessThan(1200);
  expect(between).toEqual([
    { left: width, right: panel },
    { left: width, right: panel }
  ]);
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
        branches: ["develop"],
        seq: 1
      }
    ]);
  await expect(page.locator('#sideViews [data-ref="develop"]')).toHaveAttribute(
    "aria-selected",
    "true"
  );

  // The selection is drawn as VS Code's lists draw it: the active colour while
  // the keyboard is in the views, the quieter inactive one once it is not.
  await page.evaluate(() => {
    const root = globalThis.document.documentElement.style;
    root.setProperty("--vscode-list-activeSelectionBackground", "rgb(1, 2, 3)");
    root.setProperty("--vscode-list-inactiveSelectionBackground", "rgb(4, 5, 6)");
  });
  const develop = page.locator('#sideViews [data-ref="develop"]');
  const background = () =>
    develop.evaluate((el) => globalThis.getComputedStyle(el).backgroundColor);
  await expect(develop).toBeFocused();
  expect(await background()).toBe("rgb(1, 2, 3)");
  await develop.evaluate((el) => (el as HTMLElement).blur());
  expect(await background()).toBe("rgb(4, 5, 6)");
});

test("the Stash view is the column's third section, a long list scrolling inside it, its files' changes in the theme's colours", async ({
  page
}) => {
  await hostSays(page, await sideViewState(page, [], stashList(60)));
  const stashView = page.locator("#stashView");
  await expect(stashView.locator(".sideViewRow.stash")).toHaveCount(60);

  // Below the other two, inside the window: sixty stashes do not push the
  // column past its bottom, nor the Branches view out of it.
  const remotes = (await page.locator("#remotesView").boundingBox())!;
  const stash = (await stashView.boundingBox())!;
  expect(stash.y).toBeGreaterThanOrEqual(remotes.y + remotes.height);
  expect(stash.y + stash.height).toBeLessThanOrEqual(700);
  await expect(page.locator('#sideViews [data-ref="develop"]')).toBeInViewport();
  const body = stashView.locator(".sideViewBody");
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  // Expanded, its files carry their change's letter in the colour VS Code's
  // file decorations give it.
  await page.evaluate(() => {
    const root = globalThis.document.documentElement.style;
    root.setProperty("--vscode-gitDecoration-addedResourceForeground", "rgb(1, 2, 3)");
    root.setProperty("--vscode-gitDecoration-untrackedResourceForeground", "rgb(4, 5, 6)");
  });
  await stashView.locator('[data-stash="stash0"]').first().click();
  await expect
    .poll(() => posted(page, "sideViewStashFiles"))
    .toEqual([{ command: "sideViewStashFiles", id: "stash0" }]);
  const repo = await harnessRepo(page);
  await hostSays(page, {
    command: "sideViewStashFiles",
    repo,
    id: "stash0",
    files: [
      { path: "a.txt", name: "a.txt", dir: "", badge: "A", tooltip: "a.txt" },
      { path: "b.txt", name: "b.txt", dir: "", badge: "U", tooltip: "b.txt" }
    ]
  });
  const badges = stashView.locator(".sideViewFileBadge");
  await expect(badges).toHaveText(["A", "U"]);
  expect(
    await badges.evaluateAll((els) => els.map((el) => globalThis.getComputedStyle(el).color))
  ).toEqual(["rgb(1, 2, 3)", "rgb(4, 5, 6)"]);
});
