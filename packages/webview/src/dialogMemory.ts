/**
 * Pure helpers backing the dialog "Remember my choice" feature.
 *
 * Option-bearing confirmation dialogs (merge, cherry-pick, reset, …) can offer
 * a "Remember my choice" checkbox. When set, the chosen values of the inputs
 * flagged with `remember: true` are persisted (globally, in the extension host)
 * and applied as defaults the next time the same dialog opens.
 *
 * Memory is keyed by the input's `name` rather than its position, so reordering
 * or adding inputs later degrades gracefully (an unmatched name simply falls
 * back to the caller's default) instead of mis-applying a remembered value.
 * Only selects and checkboxes can be remembered; free-text inputs never are.
 */

export type RememberedValues = { [inputName: string]: string };

/** True when this input opts into being remembered (only selects/checkboxes can). */
function isRemembered(input: DialogInput): input is DialogSelectInput | DialogCheckboxInput {
  return (input.type === "select" || input.type === "checkbox") && input.remember === true;
}

/**
 * Return a copy of `inputs` with remembered values applied to each input flagged
 * `remember: true`. Checkboxes adopt "checked"/"unchecked"; selects adopt the
 * remembered option value, but only when it still matches an available option.
 */
export function applyDialogMemory(
  inputs: DialogInput[],
  memory: RememberedValues | undefined
): DialogInput[] {
  if (memory === undefined) return inputs;
  return inputs.map((input) => {
    if (!isRemembered(input)) return input;
    const remembered = memory[input.name];
    if (remembered === undefined) return input;
    if (input.type === "checkbox") {
      return { ...input, value: remembered === "checked" };
    }
    if (input.options.some((o) => o.value === remembered)) {
      return { ...input, default: remembered };
    }
    return input;
  });
}

/**
 * Collect the values of the inputs flagged `remember: true`, keyed by input name.
 * `values` is the dialog's submitted values array, aligned by index with `inputs`.
 */
export function extractDialogMemory(inputs: DialogInput[], values: string[]): RememberedValues {
  const remembered: RememberedValues = {};
  for (let i = 0; i < inputs.length; i++) {
    if (isRemembered(inputs[i])) remembered[inputs[i].name] = values[i];
  }
  return remembered;
}
