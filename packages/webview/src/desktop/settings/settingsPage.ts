/* The desktop app's settings page (#397): one row per setting the app has,
 * built from the schema the host hands it, and the theme above them. Each
 * change is sent to the host as it is made; the host writes it and answers
 * with what the setting is now, which the row then shows. */

import { escapeHtml, fillTemplate } from "@ging/webview/utils/html";
import { vscode } from "@ging/webview/utils/vscode";

import { renderDescriptionMarkdown } from "./markdown";
import type {
  SettingsPageSetting,
  SettingsPageState,
  SettingsRequest,
  SettingsResponse,
  ThemeChoice
} from "./protocol";
import { THEME_CHOICES } from "./protocol";

/** Only the desktop bundle carries these, so they live here rather than in
 *  `media/main.css`, which ships in the extension too (ADR-0031). */
const STYLES = `
body.settingsPage { padding: 0; }
#settings { max-width: 820px; margin: 0 auto; padding: 16px 24px 48px; }
#settings h1 { font-size: 26px; font-weight: normal; margin: 8px 0 16px; }
.settingRow, .themeRow { padding: 10px 12px; margin: 0 -12px; border-left: 2px solid transparent; }
.settingRow:target { border-left-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
.settingTitle { font-weight: 600; margin-bottom: 4px; }
.settingCategory { font-weight: normal; }
.settingDescription { color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
.settingDescription p { margin: 0 0 4px; }
.settingDescription code { font-family: var(--vscode-editor-font-family); }
.settingDescription a { color: var(--vscode-textLink-foreground); }
.settingControl input[type="text"], .settingControl input[type="number"], .settingControl select, .settingControl textarea {
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; font: inherit;
}
.settingControl select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border-color: var(--vscode-dropdown-border); }
.settingControl input[type="text"] { width: 100%; max-width: 480px; box-sizing: border-box; }
.settingControl input[type="number"] { width: 120px; }
.settingControl textarea { width: 100%; box-sizing: border-box; min-height: 64px; font-family: var(--vscode-editor-font-family); }
.settingControl label { display: flex; align-items: flex-start; gap: 6px; }
.settingHint { color: var(--vscode-descriptionForeground); font-size: 90%; margin-top: 2px; }
.settingError { color: var(--vscode-errorForeground); margin-top: 4px; }
`;

const post = (message: SettingsRequest) =>
  (vscode.postMessage as unknown as (m: SettingsRequest) => void)(message);

/** `Dates: Format` as its category and its name, which the title sets apart. */
function titleHtml(title: string): string {
  const colon = title.lastIndexOf(": ");
  if (colon < 0) return `<span class="settingName">${escapeHtml(title)}</span>`;
  return `<span class="settingCategory">${escapeHtml(title.slice(0, colon + 2))}</span><span class="settingName">${escapeHtml(title.slice(colon + 2))}</span>`;
}

function descriptionHtml(setting: SettingsPageSetting): string {
  return setting.markdown
    ? renderDescriptionMarkdown(setting.description)
    : `<p>${escapeHtml(setting.description)}</p>`;
}

/** A setting the page edits as JSON text: a list, or an object. */
const editedAsJson = (setting: SettingsPageSetting) =>
  setting.type === "array" || setting.type === "object";

const asJson = (value: unknown) => JSON.stringify(value, null, 2);

/** The control for `setting`, by its schema: a checkbox, a choice, a number,
 *  a line of text, or JSON for the rest. Boolean rows carry their description
 *  beside the checkbox, as VS Code's Settings editor does. */
function controlHtml(setting: SettingsPageSetting, editAsJson: string): string {
  const id = `control:${setting.key}`;
  if (setting.type === "boolean") {
    return `<label><input type="checkbox" id="${escapeHtml(id)}"><span class="settingDescription">${descriptionHtml(setting)}</span></label>`;
  }
  if (setting.enum !== undefined) {
    const options = setting.enum
      .map((value, i) => {
        const hint = setting.enumDescriptions?.[i];
        return `<option value="${i}"${hint === undefined ? "" : ` title="${escapeHtml(hint)}"`}>${escapeHtml(String(value))}</option>`;
      })
      .join("");
    return `<select id="${escapeHtml(id)}">${options}</select>`;
  }
  if (setting.type === "number" || setting.type === "integer") {
    const attrs = [
      setting.minimum === undefined ? "" : ` min="${setting.minimum}"`,
      setting.maximum === undefined ? "" : ` max="${setting.maximum}"`,
      ` step="${setting.type === "integer" ? 1 : "any"}"`
    ].join("");
    return `<input type="number" id="${escapeHtml(id)}"${attrs}>`;
  }
  if (editedAsJson(setting)) {
    return `<textarea id="${escapeHtml(id)}" spellcheck="false"></textarea><div class="settingHint">${escapeHtml(editAsJson)}</div>`;
  }
  return `<input type="text" id="${escapeHtml(id)}" spellcheck="false">`;
}

function rowHtml(setting: SettingsPageSetting, editAsJson: string): string {
  const description =
    setting.type === "boolean"
      ? ""
      : `<div class="settingDescription">${descriptionHtml(setting)}</div>`;
  return `<div class="settingRow" id="${escapeHtml(setting.key)}" data-type="${setting.type}">
<div class="settingTitle">${titleHtml(setting.title)}</div>
${description}<div class="settingControl">${controlHtml(setting, editAsJson)}</div>
<div class="settingError" hidden></div>
</div>`;
}

/** One row on the page: shows a value, and says why one was not saved. */
type Row = { show(value: unknown): void; showError(message: string | null): void };

/** Wire `row`'s control to send each change, and show the values it is told. */
function bindRow(
  setting: SettingsPageSetting,
  element: HTMLElement,
  state: SettingsPageState
): Row {
  const control = element.querySelector<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(
    ".settingControl input, .settingControl select, .settingControl textarea"
  )!;
  const error = element.querySelector<HTMLElement>(".settingError")!;
  let current = setting.value;

  const showError = (message: string | null) => {
    error.hidden = message === null;
    error.textContent = message ?? "";
  };
  const show = (value: unknown) => {
    current = value;
    if (setting.type === "boolean") control.checked = value === true;
    else if (setting.enum !== undefined) control.value = String(setting.enum.indexOf(value));
    else if (editedAsJson(setting)) control.value = asJson(value);
    else control.value = value === undefined || value === null ? "" : String(value);
  };
  const send = (value: unknown) => post({ command: "updateSetting", key: setting.key, value });

  control.addEventListener("change", () => {
    if (setting.type === "boolean") return send(control.checked);
    if (setting.enum !== undefined) return send(setting.enum[Number(control.value)]);
    if (setting.type === "number" || setting.type === "integer") {
      // An emptied or half-typed number is no value to send: back to the last.
      if (control.value.trim() === "") return show(current);
      return send(Number(control.value));
    }
    if (editedAsJson(setting)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(control.value);
      } catch {
        return showError(state.strings.invalidJson);
      }
      return send(parsed);
    }
    send(control.value);
  });
  show(setting.value);
  return { show, showError };
}

function themeRowHtml(state: SettingsPageState): string {
  const { strings } = state;
  const label: Record<ThemeChoice, string> = {
    system: strings.themeSystem,
    dark: strings.themeDark,
    light: strings.themeLight
  };
  const options = THEME_CHOICES.map(
    (choice) =>
      `<option value="${choice}"${choice === state.theme ? " selected" : ""}>${escapeHtml(label[choice])}</option>`
  ).join("");
  return `<div class="themeRow" id="ging-theme">
<div class="settingTitle"><span class="settingName">${escapeHtml(strings.themeTitle)}</span></div>
<div class="settingDescription"><p>${escapeHtml(strings.themeDescription)}</p></div>
<div class="settingControl"><select id="control:ging-theme">${options}</select></div>
</div>`;
}

/** Build the page from `state` into `root`, and answer the host's replies.
 *  Called once, by the desktop entry, on a page its host says is a settings
 *  page. */
export function startSettingsPage(state: SettingsPageState, root: HTMLElement): void {
  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.appendChild(style);
  document.body.classList.add("settingsPage");
  document.title = state.strings.title;

  root.innerHTML = `<h1>${escapeHtml(state.strings.title)}</h1>${themeRowHtml(state)}${state.settings
    .map((setting) => rowHtml(setting, state.strings.editAsJson))
    .join("")}`;

  const theme = root.querySelector<HTMLSelectElement>("#ging-theme select")!;
  theme.addEventListener("change", () =>
    post({ command: "setTheme", theme: theme.value as ThemeChoice })
  );

  const rows = new Map<string, Row>();
  for (const setting of state.settings) {
    rows.set(setting.key, bindRow(setting, document.getElementById(setting.key)!, state));
  }

  window.addEventListener("message", (event: MessageEvent<SettingsResponse | undefined>) => {
    const message = event.data;
    // Only the host's answers to this page; anything else is not for it.
    if (message?.command !== "settingUpdated") return;
    const row = rows.get(message.key);
    if (row === undefined) return;
    row.show(message.value);
    row.showError(
      message.error === null ? null : fillTemplate(state.strings.notSaved, message.error)
    );
  });
}
