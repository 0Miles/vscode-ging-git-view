/* The main process's log, until the desktop `HostLogger` exists (#387): the
 * process's own stdout and stderr, which is also where the Electron E2E reads
 * it. One place, so replacing it is one change. */

export const log = {
  info(message: string): void {
    // oxlint-disable-next-line eslint/no-console -- stands in for HostLogger (#387)
    console.log(`[ging] ${message}`);
  },
  warn(message: string): void {
    // oxlint-disable-next-line eslint/no-console -- stands in for HostLogger (#387)
    console.warn(`[ging] ${message}`);
  }
};
