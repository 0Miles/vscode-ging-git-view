/* The host prompt overlay's styles. Written into the page by the desktop
 * entry's own bundle rather than added to media/main.css, which ships in the
 * extension too (ADR-0031). The overlay sits outside <body> (see
 * hostPromptOverlay.ts), so it inherits nothing of the body's font or colour
 * and states them itself. */

export const HOST_PROMPT_STYLES = `
#hostPrompt {
  box-sizing: border-box;
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  margin: 48px auto auto;
  padding: 12px;
  border: 1px solid var(--vscode-widget-border, transparent);
  border-radius: 6px;
  background-color: var(--vscode-quickInput-background, var(--vscode-editorWidget-background));
  color: var(--vscode-quickInput-foreground, var(--vscode-editorWidget-foreground));
  box-shadow: 0 0 8px 2px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  font-weight: var(--vscode-font-weight, normal);
  overflow: hidden;
}
#hostPrompt[open] {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
#hostPrompt::backdrop {
  background-color: rgba(0, 0, 0, 0.3);
}
#hostPrompt .hostPromptMessage {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
#hostPrompt .hostPromptDetail {
  color: var(--vscode-descriptionForeground);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
#hostPrompt .hostPromptText {
  box-sizing: border-box;
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  background-color: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
}
#hostPrompt .hostPromptText:focus {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
#hostPrompt .hostPromptText::placeholder {
  color: var(--vscode-input-placeholderForeground);
}
#hostPrompt .hostPromptList {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  max-height: 50vh;
}
#hostPrompt .hostPromptItem {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 3px;
  cursor: pointer;
}
#hostPrompt .hostPromptItem[hidden] {
  display: none;
}
#hostPrompt .hostPromptItem:hover {
  background-color: var(--vscode-list-hoverBackground);
}
#hostPrompt .hostPromptItem.active {
  background-color: var(--vscode-quickInputList-focusBackground, var(--vscode-list-activeSelectionBackground));
  color: var(--vscode-quickInputList-focusForeground, var(--vscode-list-activeSelectionForeground));
}
#hostPrompt .hostPromptItemDescription {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}
#hostPrompt .hostPromptItem {
  flex-wrap: wrap;
}
#hostPrompt .hostPromptItemDetail {
  flex-basis: 100%;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  overflow-wrap: anywhere;
}
#hostPrompt .hostPromptItem.active .hostPromptItemDetail {
  color: inherit;
}
#hostPrompt .hostPromptItem.separatorAbove {
  margin-top: 4px;
  border-top: 1px solid var(--vscode-widget-border);
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
/* A named group's heading (\`PickItem.separatorAbove\` a string): the rule, with
   the name under it, as VS Code's QuickPick writes a separator's label. */
#hostPrompt .hostPromptGroup {
  margin-top: 4px;
  padding: 4px 6px 2px;
  border-top: 1px solid var(--vscode-widget-border);
  color: var(--vscode-descriptionForeground);
  font-size: 0.85em;
  cursor: default;
}
#hostPrompt .hostPromptGroup:first-child {
  margin-top: 0;
  border-top: 0;
}
#hostPrompt .hostPromptError {
  padding: 4px 6px;
  border: 1px solid var(--vscode-errorForeground);
  color: var(--vscode-errorForeground);
  overflow-wrap: anywhere;
}
#hostPrompt .hostPromptItemWarning svg {
  display: block;
  width: 14px;
  height: 14px;
  fill: var(--vscode-editorWarning-foreground, #cca700);
}
#hostPrompt .hostPromptButtons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
#hostPrompt .hostPromptButtons .primary {
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
`;
