/* The `--vscode-*` variables VS Code injects into every webview, which the
 * desktop host has to supply itself (#386). The webview reads them from the
 * inline style of `<html>` (`getVSCodeStyle`, and the MutationObserver that
 * watches that attribute for a theme change), so that is where they go —
 * declared in a stylesheet they would style the page but read as "".
 *
 * The colours follow VS Code's default themes, Dark Modern and Light Modern,
 * falling back to the colour registry's defaults where those themes set
 * nothing. Variables those themes leave unset are left unset here too (the
 * list is in `tests/theme.test.ts`, which fails when the webview starts reading
 * a variable neither theme gives). */

export type ThemeKind = "dark" | "light";

export type Theme = {
  /** The class VS Code puts on `<body>`, which `main.css` keys some rules on. */
  bodyClass: `vscode-${ThemeKind}`;
  /** Name → value, every name starting `--vscode-`. */
  variables: Record<string, string>;
};

const DARK: Record<string, string> = {
  "--vscode-button-background": "#0078d4",
  "--vscode-button-border": "#ffffff12",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-button-hoverBackground": "#026ec1",
  "--vscode-button-secondaryBackground": "#313131",
  "--vscode-button-secondaryForeground": "#cccccc",
  "--vscode-button-secondaryHoverBackground": "#3c3c3c",
  "--vscode-checkbox-background": "#313131",
  "--vscode-checkbox-border": "#3c3c3c",
  "--vscode-checkbox-foreground": "#cccccc",
  "--vscode-checkbox-selectBackground": "#202020",
  "--vscode-checkbox-selectBorder": "#cccccc",
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-disabledForeground": "#cccccc80",
  "--vscode-dropdown-background": "#313131",
  "--vscode-dropdown-border": "#3c3c3c",
  "--vscode-dropdown-foreground": "#cccccc",
  "--vscode-editor-background": "#1f1f1f",
  "--vscode-editor-findMatchBackground": "#9e6a03",
  "--vscode-editor-findMatchHighlightBackground": "#ea5c0055",
  "--vscode-editor-foreground": "#cccccc",
  "--vscode-editorWidget-background": "#202020",
  "--vscode-editorWidget-border": "#454545",
  "--vscode-editorWidget-foreground": "#cccccc",
  "--vscode-errorForeground": "#f85149",
  "--vscode-focusBorder": "#0078d4",
  "--vscode-foreground": "#cccccc",
  "--vscode-gitDecoration-addedResourceForeground": "#81b88b",
  "--vscode-gitDecoration-deletedResourceForeground": "#c74e39",
  "--vscode-gitDecoration-modifiedResourceForeground": "#e2c08d",
  "--vscode-gitDecoration-untrackedResourceForeground": "#73c991",
  "--vscode-icon-foreground": "#cccccc",
  "--vscode-input-background": "#313131",
  "--vscode-input-border": "#3c3c3c",
  "--vscode-input-foreground": "#cccccc",
  "--vscode-input-placeholderForeground": "#989898",
  "--vscode-inputOption-activeBackground": "#2489db82",
  "--vscode-inputOption-activeBorder": "#2488db",
  "--vscode-inputOption-activeForeground": "#ffffff",
  "--vscode-inputValidation-warningBackground": "#352a05",
  "--vscode-list-activeSelectionBackground": "#04395e",
  "--vscode-list-activeSelectionForeground": "#ffffff",
  "--vscode-list-dropBackground": "#383b3d",
  "--vscode-list-focusOutline": "#0078d4",
  "--vscode-list-hoverBackground": "#2a2d2e",
  "--vscode-menu-background": "#1f1f1f",
  "--vscode-menu-border": "#454545",
  "--vscode-menu-foreground": "#cccccc",
  "--vscode-menu-selectionBackground": "#0078d4",
  "--vscode-menu-selectionForeground": "#ffffff",
  "--vscode-menu-separatorBackground": "#454545",
  "--vscode-panel-border": "#2b2b2b",
  "--vscode-quickInput-background": "#222222",
  "--vscode-quickInput-foreground": "#cccccc",
  "--vscode-quickInputList-focusBackground": "#04395e",
  "--vscode-quickInputList-focusForeground": "#ffffff",
  "--vscode-scrollbar-shadow": "#000000",
  "--vscode-statusBarItem-warningBackground": "#7a6400",
  "--vscode-textLink-activeForeground": "#4daafc",
  "--vscode-textLink-foreground": "#4daafc",
  "--vscode-toolbar-activeBackground": "#63666750",
  "--vscode-toolbar-hoverBackground": "#5a5d5e50",
  "--vscode-widget-border": "#313131",
  "--vscode-widget-shadow": "#0000005c"
};

const LIGHT: Record<string, string> = {
  "--vscode-button-background": "#005fb8",
  "--vscode-button-border": "#0000001a",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-button-hoverBackground": "#0258a8",
  "--vscode-button-secondaryBackground": "#e5e5e5",
  "--vscode-button-secondaryForeground": "#3b3b3b",
  "--vscode-button-secondaryHoverBackground": "#cccccc",
  "--vscode-checkbox-background": "#f8f8f8",
  "--vscode-checkbox-border": "#cecece",
  "--vscode-checkbox-foreground": "#3b3b3b",
  "--vscode-checkbox-selectBackground": "#f8f8f8",
  "--vscode-checkbox-selectBorder": "#3b3b3b",
  "--vscode-descriptionForeground": "#3b3b3b",
  "--vscode-disabledForeground": "#61616180",
  "--vscode-dropdown-background": "#ffffff",
  "--vscode-dropdown-border": "#cecece",
  "--vscode-dropdown-foreground": "#3b3b3b",
  "--vscode-editor-background": "#ffffff",
  "--vscode-editor-findMatchBackground": "#a8ac94",
  "--vscode-editor-findMatchHighlightBackground": "#ea5c0055",
  "--vscode-editor-foreground": "#3b3b3b",
  "--vscode-editorWidget-background": "#f8f8f8",
  "--vscode-editorWidget-border": "#c8c8c8",
  "--vscode-editorWidget-foreground": "#3b3b3b",
  "--vscode-errorForeground": "#f85149",
  "--vscode-focusBorder": "#005fb8",
  "--vscode-foreground": "#3b3b3b",
  "--vscode-gitDecoration-addedResourceForeground": "#587c0c",
  "--vscode-gitDecoration-deletedResourceForeground": "#ad0707",
  "--vscode-gitDecoration-modifiedResourceForeground": "#895503",
  "--vscode-gitDecoration-untrackedResourceForeground": "#007100",
  "--vscode-icon-foreground": "#3b3b3b",
  "--vscode-input-background": "#ffffff",
  "--vscode-input-border": "#cecece",
  "--vscode-input-foreground": "#3b3b3b",
  "--vscode-input-placeholderForeground": "#767676",
  "--vscode-inputOption-activeBackground": "#bed6ed",
  "--vscode-inputOption-activeBorder": "#005fb8",
  "--vscode-inputOption-activeForeground": "#000000",
  "--vscode-inputValidation-warningBackground": "#f6f5d2",
  "--vscode-list-activeSelectionBackground": "#e8e8e8",
  "--vscode-list-activeSelectionForeground": "#000000",
  "--vscode-list-dropBackground": "#d6ebff",
  "--vscode-list-focusOutline": "#005fb8",
  "--vscode-list-hoverBackground": "#f2f2f2",
  "--vscode-menu-background": "#ffffff",
  "--vscode-menu-border": "#cecece",
  "--vscode-menu-foreground": "#3b3b3b",
  "--vscode-menu-selectionBackground": "#005fb8",
  "--vscode-menu-selectionForeground": "#ffffff",
  "--vscode-menu-separatorBackground": "#d4d4d4",
  "--vscode-panel-border": "#e5e5e5",
  "--vscode-quickInput-background": "#f8f8f8",
  "--vscode-quickInput-foreground": "#3b3b3b",
  "--vscode-quickInputList-focusBackground": "#e8e8e8",
  "--vscode-quickInputList-focusForeground": "#000000",
  "--vscode-scrollbar-shadow": "#dddddd",
  "--vscode-statusBarItem-warningBackground": "#725102",
  "--vscode-textLink-activeForeground": "#005fb8",
  "--vscode-textLink-foreground": "#005fb8",
  "--vscode-toolbar-activeBackground": "#a6a6a650",
  "--vscode-toolbar-hoverBackground": "#b8b8b850",
  "--vscode-widget-border": "#e5e5e5",
  "--vscode-widget-shadow": "#00000029"
};

/** VS Code's default `workbench` and `editor` fonts on each platform, which it
 *  injects the same way. Single quotes only: the values end up inside a
 *  double-quoted `style` attribute. */
function fonts(platform: NodeJS.Platform): Record<string, string> {
  const [ui, editor, editorSize] =
    platform === "win32"
      ? ["'Segoe WPC', 'Segoe UI', sans-serif", "Consolas, 'Courier New', monospace", "14px"]
      : platform === "darwin"
        ? [
            "-apple-system, BlinkMacSystemFont, sans-serif",
            "Menlo, Monaco, 'Courier New', monospace",
            "12px"
          ]
        : [
            "system-ui, 'Ubuntu', 'Droid Sans', sans-serif",
            "'Droid Sans Mono', 'monospace', monospace",
            "14px"
          ];
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
  return {
    bodyClass: `vscode-${kind}`,
    variables: { ...(kind === "dark" ? DARK : LIGHT), ...fonts(platform) }
  };
}

const BODY_CLASSES: readonly Theme["bodyClass"][] = ["vscode-dark", "vscode-light"];

/** Switch a page that is already showing to `theme`, as VS Code does when the
 *  user changes theme: the variables in place on `<html>` (the webview's
 *  observer picks the change up) and the body's kind class swapped, leaving the
 *  classes the webview put there itself. Both themes set the same names, so
 *  nothing is left over from the one before. */
export function applyTheme(doc: Document, theme: Theme): void {
  for (const [name, value] of Object.entries(theme.variables)) {
    doc.documentElement.style.setProperty(name, value);
  }
  doc.body.classList.remove(...BODY_CLASSES);
  doc.body.classList.add(theme.bodyClass);
}
