import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type ElectronApplication, expect, type Page } from "@playwright/test";

/**
 * What an E2E does to the app's main process (ADR-0032): click the
 * application menu's entries, and stand in for what the system would show or
 * start — its folder dialog, its message boxes, its terminal — so nothing
 * outside the app opens and what the app asked for can be read back. Each
 * stand-in is put in place with `electronApp.evaluate`, on the module the
 * main process looks it up on when it is called.
 */

/** Whether the menu's entry `id` is enabled now, as the main process holds
 *  it; `null` when there is no such entry. */
export function menuEnabled(electronApp: ElectronApplication, id: string): Promise<boolean | null> {
  return electronApp.evaluate(
    ({ Menu }, wanted) => Menu.getApplicationMenu()?.getMenuItemById(wanted)?.enabled ?? null,
    id
  );
}

/** The menu entry `id`, clicked as the menu Electron built would click it —
 *  no window, no check of `enabled` — answering whether it was enabled. */
export function clickMenu(electronApp: ElectronApplication, id: string): Promise<boolean | null> {
  return electronApp.evaluate(({ Menu }, wanted) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(wanted);
    item?.click();
    return item ? item.enabled : null;
  }, id);
}

/** The folder dialog answered with `folder` from now on, each time it is
 *  asked; what it was asked with is kept, for `folderDialogs` to read. */
export async function answerFolderDialog(
  electronApp: ElectronApplication,
  folder: string
): Promise<void> {
  await electronApp.evaluate(({ dialog }, answer) => {
    const asked: unknown[] = [];
    (globalThis as Record<string, unknown>).askedFolders = asked;
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      asked.push(args.at(-1));
      return { canceled: false, filePaths: [answer] };
    }) as typeof dialog.showOpenDialog;
  }, folder);
}

/** What the folder dialog was asked with since `answerFolderDialog`. */
export const folderDialogs = (electronApp: ElectronApplication) =>
  electronApp.evaluate(
    () => ((globalThis as Record<string, unknown>).askedFolders as unknown[]) ?? []
  );

/** Every message box answered with its first button, and kept, as the app
 *  put it, for `messageBoxes` to read. */
export async function answerMessageBoxes(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    const asked: unknown[] = [];
    (globalThis as Record<string, unknown>).askedBoxes = asked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      asked.push(args.at(-1));
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
}

/** The message boxes shown since `answerMessageBoxes`. */
export const messageBoxes = (electronApp: ElectronApplication) =>
  electronApp.evaluate(
    () => ((globalThis as Record<string, unknown>).askedBoxes as unknown[]) ?? []
  );

/** A terminal the app asked for, as the stand-in took it. */
export type TerminalStarted = { kind: "terminal"; command: string; args: string[]; cwd: string };

/**
 * The system's terminal stood in for: it is the one detached process the app
 * starts — git's are not, and still run — so a detached `spawn` is taken in
 * its place, kept, and reported started. No terminal opens. Each is kept in
 * the main process's global list `into`, looked up when the terminal is
 * asked for: `terminals` for `terminalsStarted` to read, or a list of the
 * caller's that other stand-ins write too (actions.spec.ts).
 */
export async function standInTerminals(
  electronApp: ElectronApplication,
  into = "terminals"
): Promise<void> {
  await electronApp.evaluate((_, key) => {
    const lists = globalThis as Record<string, unknown>;
    lists[key] ??= [];
    const node = process.mainModule!.require.bind(process.mainModule);
    const childProcess = node("node:child_process") as typeof import("node:child_process");
    const { EventEmitter } = node("node:events") as typeof import("node:events");
    const realSpawn = childProcess.spawn;
    childProcess.spawn = ((command: string, args: string[], options?: { detached?: boolean }) => {
      if (options?.detached !== true) return realSpawn(command, args, options ?? {});
      (lists[key] as unknown[]).push({
        kind: "terminal",
        command,
        args,
        cwd: (options as { cwd: string }).cwd
      });
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as typeof childProcess.spawn;
  }, into);
}

/** The folders the terminals stood in for were started in, in order. */
export const terminalsStarted = (electronApp: ElectronApplication): Promise<string[]> =>
  electronApp.evaluate(() =>
    (((globalThis as Record<string, unknown>).terminals as TerminalStarted[]) ?? []).map(
      ({ cwd }) => cwd
    )
  );

/**
 * A terminal on Linux, first on `env`'s PATH: the app looks its terminal up on
 * the PATH's absolute folders (terminal.ts), and a CI machine may have none.
 * Named as Debian's alternatives name one, `x-terminal-emulator`, the first the
 * app tries. When it is run, it writes the folder it was started in to the
 * file `startedIn`, and exits; nothing opens. Before the app is launched on
 * `env`.
 */
export function putTerminalOnPath(
  env: NodeJS.ProcessEnv,
  dir: string
): { program: string; startedIn: string } {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const program = path.join(bin, "x-terminal-emulator");
  const startedIn = path.join(dir, "terminal-started-in");
  writeFileSync(program, `#!/bin/sh\npwd -P >> '${startedIn.replaceAll("'", "'\\''")}'\n`, {
    mode: 0o755
  });
  env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
  return { program, startedIn };
}

/** Open the settings from the application menu's Settings… entry, found by
 *  its id as #390's E2E finds its own (ADR-0032); its accelerator is the
 *  template's, tested in appMenu.test.ts. */
export async function openSettings(electronApp: ElectronApplication): Promise<Page> {
  const opened = electronApp.waitForEvent("window");
  expect(
    await electronApp.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("ging.settings");
      item?.click();
      return item ? { enabled: item.enabled, accelerator: item.accelerator } : null;
    })
  ).toEqual({ enabled: true, accelerator: "CmdOrCtrl+," });
  const settings = await opened;
  await expect(settings.locator("html")).toHaveAttribute("data-ging-page", "settings");
  return settings;
}

/** A setting's row on the settings page, by its key. */
export const settingRow = (settings: Page, key: string) => settings.locator(`[id="${key}"]`);
