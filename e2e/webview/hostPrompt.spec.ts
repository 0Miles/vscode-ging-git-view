import { expect, type Page, test } from "@playwright/test";

import { harnessPage, harnessRepo, hostSays, pageErrors, posted } from "./harness";

// The host prompt overlay of the desktop entry (#390), in a real browser: the
// desktop host's questions shown one at a time over the graph's own dialog,
// which they must neither replace nor close. The host's half is played here,
// by posting its messages to the page as the preload does, and by reading the
// page's replies off the harness's record of what it posted.

const harnessUrl = harnessPage("desktop");

/** A host prompt (HostPromptMessage in packages/webview/src/desktop/hostPrompt.ts). */
function prompt(id: number, asked: Record<string, unknown>) {
  return { command: "hostPrompt", id, prompt: asked, labels: { ok: "OK", cancel: "Cancel" } };
}

const answers = (page: Page) => posted(page, "hostPromptAnswer");

/** The id of what holds focus. */
const focused = (page: Page) => page.evaluate(() => globalThis.document.activeElement?.id ?? null);

/** What went wrong on the page during the test: nothing, ever. */
let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = pageErrors(page);
  await page.goto(harnessUrl);
  await expect(page.locator("#commitTable tr.commit")).toHaveCount(3);
  // The page said it listens, so the host may send its prompts.
  expect(await posted(page, "hostPromptReady")).toHaveLength(1);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("two prompts are shown one at a time, in the order they came", async ({ page }) => {
  await hostSays(page, prompt(1, { kind: "input", prompt: "First question", password: false }));
  await hostSays(page, prompt(2, { kind: "choose", message: "Second question", actions: ["Yes"] }));

  const overlay = page.locator("#hostPrompt");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("First question");
  await expect(overlay).not.toContainText("Second question");

  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await expect(overlay).toContainText("Second question");
  await expect(overlay).not.toContainText("First question");

  await overlay.getByRole("button", { name: "Yes" }).click();
  await expect(overlay).toBeHidden();
  expect(await answers(page)).toEqual([
    { command: "hostPromptAnswer", id: 1, answer: "one" },
    { command: "hostPromptAnswer", id: 2, answer: 0 }
  ]);
});

test("a pick narrows its rows as the filter is typed, and answers the row chosen", async ({
  page
}) => {
  await hostSays(
    page,
    prompt(3, {
      kind: "pick",
      items: [
        { label: "origin", description: "github.com/alice" },
        { label: "upstream" },
        { label: "fork", description: "upstream's fork", warning: true }
      ],
      placeholder: "Select a remote to fetch",
      matchOnDescription: false
    })
  );
  const rows = page.locator("#hostPrompt .hostPromptItem");
  const filter = page.getByPlaceholder("Select a remote to fetch");
  await expect(filter).toBeFocused();
  await expect(rows.filter({ visible: true })).toHaveCount(3);
  // The warning is drawn by the page, not spelled into the label.
  await expect(rows.nth(2).locator(".hostPromptItemWarning svg")).toHaveCount(1);

  await page.keyboard.type("UP");
  // The label only: "fork" mentions upstream in its description, which this
  // pick does not search.
  await expect(rows.filter({ visible: true })).toHaveText(["upstream"]);
  await expect(rows.filter({ visible: true })).toHaveClass(/active/);

  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("or");
  await expect(rows.filter({ visible: true })).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  // Focus stays in the filter; it names the row the arrows moved to.
  await expect(filter).toHaveAttribute("aria-activedescendant", "hostPromptItem2");
  await expect(page.locator("#hostPrompt")).toHaveAccessibleName("Select a remote to fetch");
  await page.keyboard.press("Enter");

  await expect(page.locator("#hostPrompt")).toBeHidden();
  expect(await answers(page)).toEqual([{ command: "hostPromptAnswer", id: 3, answer: 2 }]);
});

test("a pick's rows show their detail under the label, and a rule where a group starts", async ({
  page
}) => {
  await hostSays(
    page,
    prompt(7, {
      kind: "pick",
      items: [
        { label: "Add a host...", detail: "A self-hosted forge" },
        { label: "git.example.com", description: "Gitea", separatorAbove: true },
        {
          label: "github.com",
          description: "GitHub",
          detail: "https://github.com/owner/repo/compare/my-branch"
        }
      ],
      placeholder: "Select a host",
      matchOnDescription: false
    })
  );
  const rows = page.locator("#hostPrompt .hostPromptItem");
  await expect(rows.locator(".hostPromptItemDetail")).toHaveText([
    "A self-hosted forge",
    "https://github.com/owner/repo/compare/my-branch"
  ]);
  await expect(rows.nth(1)).toHaveClass(/separatorAbove/);
  await expect(page.locator("#hostPrompt .separatorAbove")).toHaveCount(1);
  // The detail sits under the label, not beside it.
  const label = await rows.nth(0).locator(".hostPromptItemLabel").boundingBox();
  const detail = await rows.nth(0).locator(".hostPromptItemDetail").boundingBox();
  expect(detail!.y).toBeGreaterThanOrEqual(label!.y + label!.height);
  // Not filtered on: only the labels are.
  await page.keyboard.type("compare");
  await expect(rows.filter({ visible: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#hostPrompt")).toBeHidden();
});

test("an input asked again after a refusal starts from the text refused, saying why", async ({
  page
}) => {
  await hostSays(
    page,
    prompt(8, {
      kind: "input",
      prompt: "URL to open",
      password: false,
      value: "https://x/new",
      error: "The URL must contain {branch}."
    })
  );
  const input = page.locator("#hostPromptInput");
  const why = page.locator("#hostPrompt .hostPromptError");
  await expect(input).toHaveValue("https://x/new");
  await expect(why).toHaveText("The URL must contain {branch}.");
  await expect(why).toHaveAttribute("role", "alert");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveAccessibleDescription("The URL must contain {branch}.");

  await page.keyboard.press("End");
  await page.keyboard.type("/{branch}");
  await page.keyboard.press("Enter");
  expect(await answers(page)).toEqual([
    { command: "hostPromptAnswer", id: 8, answer: "https://x/new/{branch}" }
  ]);

  // A prompt that refused nothing says nothing.
  await hostSays(page, prompt(9, { kind: "input", prompt: "Host", password: false }));
  await expect(page.locator("#hostPrompt")).toContainText("Host");
  await expect(why).toHaveCount(0);
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await page.keyboard.press("Escape");
});

test("a pickMany answers the rows checked, whether the filter shows them or not", async ({
  page
}) => {
  await hostSays(
    page,
    prompt(4, {
      kind: "pickMany",
      items: [{ label: "origin", picked: true }, { label: "upstream" }, { label: "fork" }],
      matchOnDescription: false
    })
  );
  const overlay = page.locator("#hostPrompt");
  await overlay.getByText("fork").click();
  await page.keyboard.type("up");
  await overlay.getByRole("button", { name: "OK" }).click();

  expect(await answers(page)).toEqual([{ command: "hostPromptAnswer", id: 4, answer: [0, 2] }]);
});

test("a pick list writes each named group's name over its rows, while one of them shows (#459)", async ({
  page
}) => {
  await hostSays(
    page,
    prompt(7, {
      kind: "pickMany",
      items: [
        { label: "origin/dev", separatorAbove: "Remote" },
        { label: "origin/topic" },
        { label: "main", separatorAbove: "Local", picked: true },
        { label: "topic" }
      ],
      matchOnDescription: false
    })
  );
  const overlay = page.locator("#hostPrompt");
  const names = overlay.locator(".hostPromptGroup");
  await expect(names).toHaveText(["Remote", "Local"]);
  // Not rows: neither is an option, nor answers anything.
  await expect(overlay.locator('[role="option"], li:has(input)')).toHaveCount(4);

  // Each name follows its group: none of Remote's rows match.
  await page.keyboard.type("ma");
  await expect(names.filter({ visible: true })).toHaveText(["Local"]);
  await page.keyboard.press("Control+A");
  await page.keyboard.type("topic");
  await expect(names.filter({ visible: true })).toHaveText(["Remote", "Local"]);

  await overlay.getByText("origin/topic").click();
  await overlay.getByRole("button", { name: "OK" }).click();
  expect(await answers(page)).toEqual([{ command: "hostPromptAnswer", id: 7, answer: [1, 2] }]);
});

test("an input masks what is typed when asked for a password, and only then", async ({ page }) => {
  await hostSays(page, prompt(5, { kind: "input", prompt: "Username", password: false }));
  await hostSays(
    page,
    prompt(6, { kind: "input", prompt: "Password for 'https://example.com':", password: true })
  );

  const input = page.locator("#hostPromptInput");
  await expect(input).toHaveAttribute("type", "text");
  await expect(page.locator("#hostPrompt")).toHaveAccessibleName("Username");
  await page.keyboard.type("alice");
  await page.keyboard.press("Enter");

  await expect(page.locator("#hostPrompt")).toContainText("Password for");
  await expect(input).toHaveAttribute("type", "password");
  await page.keyboard.type("s3cret");
  await expect(input).toHaveValue("s3cret");
  await expect(page.locator("#hostPrompt")).not.toContainText("s3cret");
  // A focus change does not take it away (ADR-0027): git waits on it.
  await page.evaluate(() => globalThis.dispatchEvent(new Event("blur")));
  await expect(page.locator("#hostPrompt")).toBeVisible();
  await page.keyboard.press("Enter");

  expect(await answers(page)).toEqual([
    { command: "hostPromptAnswer", id: 5, answer: "alice" },
    { command: "hostPromptAnswer", id: 6, answer: "s3cret" }
  ]);
});

test("over a batch run's dialogs, a prompt neither closes them nor abandons the run", async ({
  page
}) => {
  const repo = await harnessRepo(page);
  const branch = "feature/long-branch-name";
  await hostSays(page, {
    command: "runRefBatchAction",
    repo,
    action: "delete",
    targets: [branch],
    skipped: [],
    seq: 1
  });
  await page.locator("#dialogAction").click();
  // Round 1 is out and its progress dialog up, waiting on the host.
  const progress = page.locator("#dialog #actionRunning");
  await expect(progress).toBeVisible();
  expect(await posted(page, "deleteBranches")).toHaveLength(1);
  expect(await focused(page)).toBe("dialog");

  // askpass asks while the action runs.
  await hostSays(page, prompt(7, { kind: "input", prompt: "Username", password: false }));
  const overlay = page.locator("#hostPrompt");
  await expect(overlay).toBeVisible();
  await expect(page.locator("#hostPromptInput")).toBeFocused();
  // Over the progress dialog, not in its place.
  await expect(progress).toBeAttached();
  await page.keyboard.type("alice");
  await page.keyboard.press("Enter");

  await expect(overlay).toBeHidden();
  await expect(progress).toBeVisible();
  expect(await focused(page)).toBe("dialog");

  // Round 1 comes back with a refusal a force delete can fix: the run offers it.
  await hostSays(page, {
    command: "deleteBranches",
    results: [{ ref: branch, status: "error: not fully merged", notFullyMerged: true }]
  });
  const offer = page.locator("#dialog #batchRetryOffer");
  await expect(offer).toBeVisible();

  // A prompt over the offer: Enter and Escape are the prompt's, not the
  // offer's, which neither answers nor takes away.
  await hostSays(page, prompt(8, { kind: "input", prompt: "Password", password: true }));
  await expect(overlay).toBeVisible();
  await page.keyboard.press("Enter");
  await hostSays(page, prompt(9, { kind: "choose", message: "Continue?", actions: ["Go"] }));
  await expect(overlay).toContainText("Continue?");
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();

  await expect(offer).toBeVisible();
  expect(await focused(page)).toBe("dialog");
  expect(await posted(page, "deleteBranches")).toHaveLength(1);
  expect((await answers(page)).slice(1)).toEqual([
    { command: "hostPromptAnswer", id: 8, answer: "" },
    { command: "hostPromptAnswer", id: 9, answer: null }
  ]);

  // The run is still the one in flight: accepting its offer sends round 2.
  await page.locator("#dialogAction").click();
  expect((await posted(page, "deleteBranches")).at(-1)).toMatchObject({
    refs: [branch],
    forceDelete: true
  });
});
