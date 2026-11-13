/* eslint-disable */
// B1 smoke app (#383). Throwaway: removed before the PR merges.
const { app, BrowserWindow, Menu } = require("electron");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

app.setPath("userData", process.env.SMOKE_USERDATA);
const smoke = { menuClicks: 0, forwarded: [], ignored: [] };
globalThis.smoke = smoke;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Only `--ging-open=<absolute path>` is a valid forwarded argument.
  app.on("second-instance", (_event, argv) => {
    for (const arg of argv) {
      if (!arg.startsWith("--ging-open")) continue;
      const value = arg.slice("--ging-open=".length);
      if (arg.startsWith("--ging-open=") && path.isAbsolute(value)) smoke.forwarded.push(value);
      else smoke.ignored.push(arg);
    }
  });

  const helper = spawnSync(process.execPath, [path.join(__dirname, "helper.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8"
  });
  smoke.helper = {
    status: helper.status,
    stdout: helper.stdout.trim(),
    stderr: helper.stderr.trim()
  };

  app.whenReady().then(() => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Smoke",
          submenu: [
            { id: "smoke.enabled", label: "Enabled", click: () => smoke.menuClicks++ },
            { id: "smoke.disabled", label: "Disabled", enabled: false }
          ]
        }
      ])
    );
    new BrowserWindow({ width: 400, height: 300 }).loadURL("about:blank");
  });
}
