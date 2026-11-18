/* Required by Electron before the app's own main (`electron -r <this> <app>`,
 * see launch.ts): every window the app makes is drawn where the user cannot
 * see it and never takes the keyboard or the mouse, so an E2E run leaves the
 * user's desktop alone (ADR-0032's 2026-11-18 addendum).
 *
 * Test-side only, never part of the product: the app asks for its windows as
 * it always does; this hands it a BrowserWindow that keeps the asked-for
 * geometry and content, and changes only how the window meets the desktop.
 *
 * The window is shown — inactive, fully transparent, out of the taskbar,
 * passing every mouse event through — rather than left hidden, so Chromium
 * treats its page as on screen: it paints, runs requestAnimationFrame and
 * reports `document.visibilityState` "visible", as it would for the user.
 * Windows' occlusion tracking would otherwise call a window behind others
 * hidden, so it is switched off. */

const Module = require("node:module");
const path = require("node:path");

const electron = require("electron");

const { app } = electron;

// The app reads its command line as `electron [switches] <app> [args]`
// (launchArgs.ts), and would take this file's path for the app's: it is
// taken out, so the app sees the command line it would have without it.
const required = process.argv.findIndex(
  (arg, i) =>
    (arg === "-r" || arg === "--require") &&
    i + 1 < process.argv.length &&
    path.resolve(process.argv[i + 1]) === __filename
);
if (required !== -1) process.argv.splice(required, 2);

// A window under other windows is still the test's window on screen.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// Named BrowserWindow: Electron tells its windows apart by `constructor.name`
// (`BrowserWindow.getAllWindows`, `getFocusedWindow` and the like).
const QuietWindow = class BrowserWindow extends electron.BrowserWindow {
  constructor(options = {}) {
    super({
      ...options,
      show: false,
      focusable: false,
      skipTaskbar: true,
      opacity: 0,
      webPreferences: { ...options.webPreferences, backgroundThrottling: false }
    });
    this.setIgnoreMouseEvents(true);
    if (options.show !== false) this.showInactive();
  }

  /** Shown, never brought forward. */
  show() {
    this.showInactive();
  }

  /** The user's window keeps the keyboard. */
  focus() {}

  moveTop() {}
};

// The app's `require("electron")` gets the same module but for its
// BrowserWindow. The module's exports are getters that cannot be redefined,
// hence the proxy; a getter may answer differently through one.
const quietElectron = new Proxy(electron, {
  get: (target, key, receiver) =>
    key === "BrowserWindow" ? QuietWindow : Reflect.get(target, key, receiver)
});

const load = Module._load;
Module._load = function (request, ...rest) {
  const loaded = load.call(this, request, ...rest);
  return request === "electron" ? quietElectron : loaded;
};
