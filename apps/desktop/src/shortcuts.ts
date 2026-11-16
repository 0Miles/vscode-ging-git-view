/* The desktop app's keyboard shortcuts that no menu carries yet. The settings'
 * `CmdOrCtrl+,` is caught on each window's input (#397) until the application
 * menu (#396) gives "Settings…" that accelerator; the menu then takes it over
 * and this goes. */

/** The parts of Electron's `Input` (`before-input-event`) a shortcut reads. */
export type KeyInput = {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

/** Whether `input` is `CmdOrCtrl+,`: Cmd on macOS, Ctrl elsewhere, and no
 *  other modifier. */
export function isOpenSettingsShortcut(input: KeyInput, platform: NodeJS.Platform): boolean {
  const mac = platform === "darwin";
  return (
    input.type === "keyDown" &&
    input.key === "," &&
    (mac ? input.meta && !input.control : input.control && !input.meta) &&
    !input.alt &&
    !input.shift
  );
}
