/**
 * The ids of the theme colours the extension contributes
 * (`contributes.colors` in package.json), kept free of `vscode` so the
 * manifest's definitions and the code's references can be checked against each
 * other. VS Code takes only letters, digits and dots in a colour id, and one
 * bad id stops every extension's colours registering (#432).
 */

/** The inline blame annotation's colour. */
export const BLAME_ANNOTATION_COLOR_ID = "gingGitView.blameAnnotationForeground";

/** Every colour id the code hands to a `ThemeColor`. */
export const THEME_COLOR_IDS: readonly string[] = [BLAME_ANNOTATION_COLOR_ID];
