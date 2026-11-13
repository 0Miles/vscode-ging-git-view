/* The `--vscode-*` variables VS Code injects into every webview, which the
 * desktop host has to supply itself (#386). The webview reads them from the
 * inline style of `<html>` (`getVSCodeStyle`, and the MutationObserver that
 * watches that attribute for a theme change), so that is where they go —
 * declared in a stylesheet they would style the page but read as "".
 *
 * The colours are VS Code's Dark Modern and Light Modern themes, checked value
 * by value against VS Code 1.146.0 (#386): first the theme file and the files
 * it includes (`extensions/theme-defaults/themes/dark_modern.json` →
 * `dark_plus.json` → `dark_vs.json`, and the light chain likewise), then, for
 * a colour no theme file sets, the default VS Code's colour registry gives it,
 * resolved against the theme the way VS Code resolves it. Rows taken from the
 * registry say so and name the rule; `gitDecoration.*` come from the built-in
 * git extension's contributed colours. These two themes were VS Code's
 * defaults before the "2026" pair; 1.146.0 defaults to "Dark 2026" and
 * "Light 2026". VS Code is MIT-licensed; its notice is in LICENSE.
 *
 * Colours both themes leave unset are left unset here too (the list is in
 * `tests/theme.test.ts`, which fails when the webview starts reading a variable
 * this table does not give). */

export type ThemeKind = "dark" | "light";

export type Theme = {
  kind: ThemeKind;
  /** `--vscode-editor-background`, which the window also paints itself. */
  background: string;
  /** Name → value, every name starting `--vscode-`. */
  variables: Record<string, string>;
};

/** Name → [Dark Modern, Light Modern]: one row per variable, so the two themes
 *  cannot set different names. */
const COLORS: Record<string, readonly [dark: string, light: string]> = {
  "--vscode-button-background": ["#0078d4", "#005fb8"],
  "--vscode-button-border": ["#ffffff1a", "#0000001a"],
  "--vscode-button-foreground": ["#ffffff", "#ffffff"],
  "--vscode-button-hoverBackground": ["#026ec1", "#0258a8"],
  "--vscode-button-secondaryBackground": ["#00000000", "#e5e5e5"],
  "--vscode-button-secondaryForeground": ["#cccccc", "#3b3b3b"],
  "--vscode-button-secondaryHoverBackground": ["#2b2b2b", "#cccccc"],
  "--vscode-checkbox-background": ["#313131", "#f8f8f8"],
  "--vscode-checkbox-border": ["#3c3c3c", "#cecece"],
  // registry: dropdown.foreground
  "--vscode-checkbox-foreground": ["#cccccc", "#3b3b3b"],
  // registry: editorWidget.background
  "--vscode-checkbox-selectBackground": ["#202020", "#f8f8f8"],
  // registry: icon.foreground
  "--vscode-checkbox-selectBorder": ["#cccccc", "#3b3b3b"],
  "--vscode-descriptionForeground": ["#9d9d9d", "#3b3b3b"],
  // registry
  "--vscode-disabledForeground": ["#cccccc80", "#61616180"],
  "--vscode-dropdown-background": ["#313131", "#ffffff"],
  "--vscode-dropdown-border": ["#3c3c3c", "#cecece"],
  "--vscode-dropdown-foreground": ["#cccccc", "#3b3b3b"],
  "--vscode-editor-background": ["#1f1f1f", "#ffffff"],
  // light: registry
  "--vscode-editor-findMatchBackground": ["#9e6a03", "#a8ac94"],
  // registry
  "--vscode-editor-findMatchHighlightBackground": ["#ea5c0055", "#ea5c0055"],
  "--vscode-editor-foreground": ["#cccccc", "#3b3b3b"],
  "--vscode-editorWidget-background": ["#202020", "#f8f8f8"],
  // registry: transparent(editorWidget.foreground, 0.2)
  "--vscode-editorWidget-border": ["#cccccc33", "#3b3b3b33"],
  // registry: foreground
  "--vscode-editorWidget-foreground": ["#cccccc", "#3b3b3b"],
  "--vscode-errorForeground": ["#f85149", "#f85149"],
  "--vscode-focusBorder": ["#0078d4", "#005fb8"],
  "--vscode-foreground": ["#cccccc", "#3b3b3b"],
  "--vscode-gitDecoration-addedResourceForeground": ["#81b88b", "#587c0c"],
  "--vscode-gitDecoration-deletedResourceForeground": ["#c74e39", "#ad0707"],
  "--vscode-gitDecoration-modifiedResourceForeground": ["#e2c08d", "#895503"],
  "--vscode-gitDecoration-untrackedResourceForeground": ["#73c991", "#007100"],
  "--vscode-icon-foreground": ["#cccccc", "#3b3b3b"],
  "--vscode-input-background": ["#313131", "#ffffff"],
  "--vscode-input-border": ["#3c3c3c", "#cecece"],
  "--vscode-input-foreground": ["#cccccc", "#3b3b3b"],
  "--vscode-input-placeholderForeground": ["#989898", "#767676"],
  "--vscode-inputOption-activeBackground": ["#2489db82", "#bed6ed"],
  "--vscode-inputOption-activeBorder": ["#2488db", "#005fb8"],
  // dark: registry
  "--vscode-inputOption-activeForeground": ["#ffffff", "#000000"],
  // registry
  "--vscode-inputValidation-warningBackground": ["#352a05", "#f6f5d2"],
  // dark: registry
  "--vscode-list-activeSelectionBackground": ["#04395e", "#e8e8e8"],
  // dark: registry
  "--vscode-list-activeSelectionForeground": ["#ffffff", "#000000"],
  // light: registry
  "--vscode-list-dropBackground": ["#383b3d", "#d6ebff"],
  // registry: focusBorder
  "--vscode-list-focusOutline": ["#0078d4", "#005fb8"],
  // dark: registry
  "--vscode-list-hoverBackground": ["#2a2d2e", "#f2f2f2"],
  // light: registry, dropdown.background
  "--vscode-menu-background": ["#1f1f1f", "#ffffff"],
  "--vscode-menu-border": ["#454545", "#cecece"],
  // light: registry, dropdown.foreground
  "--vscode-menu-foreground": ["#cccccc", "#3b3b3b"],
  "--vscode-menu-selectionBackground": ["#0078d4", "#005fb8"],
  // dark: registry, list.activeSelectionForeground
  "--vscode-menu-selectionForeground": ["#ffffff", "#ffffff"],
  // light: registry, transparent(foreground, 0.2)
  "--vscode-menu-separatorBackground": ["#454545", "#3b3b3b33"],
  "--vscode-panel-border": ["#2b2b2b", "#e5e5e5"],
  "--vscode-quickInput-background": ["#222222", "#f8f8f8"],
  "--vscode-quickInput-foreground": ["#cccccc", "#3b3b3b"],
  // registry: list.activeSelectionBackground
  "--vscode-quickInputList-focusBackground": ["#04395e", "#e8e8e8"],
  // registry: list.activeSelectionForeground
  "--vscode-quickInputList-focusForeground": ["#ffffff", "#000000"],
  // registry
  "--vscode-scrollbar-shadow": ["#000000", "#dddddd"],
  // registry: darken(editorWarning.foreground, 0.4)
  "--vscode-statusBarItem-warningBackground": ["#7a6400", "#735202"],
  "--vscode-textLink-activeForeground": ["#4daafc", "#005fb8"],
  "--vscode-textLink-foreground": ["#4daafc", "#005fb8"],
  // registry: lighten (dark) / darken (light) of toolbar.hoverBackground, 0.1
  "--vscode-toolbar-activeBackground": ["#63666750", "#a6a6a650"],
  // registry
  "--vscode-toolbar-hoverBackground": ["#5a5d5e50", "#b8b8b850"],
  "--vscode-widget-border": ["#313131", "#e5e5e5"],
  // registry: transparent(black, 0.36 dark / 0.16 light)
  "--vscode-widget-shadow": ["#0000005c", "#00000029"]
};

type FontPlatform = "win32" | "darwin" | "other";

/** VS Code's default `workbench` and `editor` fonts on each platform, which it
 *  injects the same way. Single quotes only: the values end up inside a
 *  double-quoted `style` attribute. */
const FONTS: Record<FontPlatform, { ui: string; editor: string; editorSize: string }> = {
  win32: {
    ui: "'Segoe WPC', 'Segoe UI', sans-serif",
    editor: "Consolas, 'Courier New', monospace",
    editorSize: "14px"
  },
  darwin: {
    ui: "-apple-system, BlinkMacSystemFont, sans-serif",
    editor: "Menlo, Monaco, 'Courier New', monospace",
    editorSize: "12px"
  },
  other: {
    ui: "system-ui, 'Ubuntu', 'Droid Sans', sans-serif",
    editor: "'Droid Sans Mono', 'monospace', monospace",
    editorSize: "14px"
  }
};

function fonts(platform: NodeJS.Platform): Record<string, string> {
  const { ui, editor, editorSize } =
    FONTS[platform === "win32" || platform === "darwin" ? platform : "other"];
  return {
    "--vscode-font-family": ui,
    "--vscode-font-size": "13px",
    "--vscode-font-weight": "normal",
    "--vscode-editor-font-family": editor,
    "--vscode-editor-font-size": editorSize,
    "--vscode-editor-font-weight": "normal"
  };
}

export function themeFor(kind: ThemeKind, platform: NodeJS.Platform): Theme {
  const column = kind === "dark" ? 0 : 1;
  const colors = Object.fromEntries(
    Object.entries(COLORS).map(([name, values]) => [name, values[column]])
  );
  return {
    kind,
    background: colors["--vscode-editor-background"],
    variables: { ...colors, ...fonts(platform) }
  };
}

/** The class VS Code puts on `<body>` for a theme's kind, which `main.css` keys
 *  some rules on. */
export function bodyClassOf(kind: ThemeKind): `vscode-${ThemeKind}` {
  return `vscode-${kind}`;
}

const KINDS: readonly ThemeKind[] = ["dark", "light"];

/** Switch a page that is already showing to `theme`, as VS Code does when the
 *  user changes theme: the variables in place on `<html>` (the webview's
 *  observer picks the change up) and the body's kind class swapped, leaving the
 *  classes the webview put there itself. Every theme sets the same names, so
 *  nothing is left over from the one before. */
export function applyTheme(doc: Document, theme: Theme): void {
  for (const [name, value] of Object.entries(theme.variables)) {
    doc.documentElement.style.setProperty(name, value);
  }
  doc.body.classList.remove(...KINDS.map(bodyClassOf));
  doc.body.classList.add(bodyClassOf(theme.kind));
}
