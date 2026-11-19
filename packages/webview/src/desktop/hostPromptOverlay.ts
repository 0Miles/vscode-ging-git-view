/* The host prompt overlay (#390): the desktop host's questions — pick,
 * pickMany, choose, input — drawn over everything else on the page, the
 * graph's own `#dialog` included, which it neither replaces nor closes.
 *
 * Why not `#dialog`: it has one slot, which a progress dialog holds for as long
 * as an action runs — and askpass asks for a credential exactly while a push or
 * fetch is running. Writing a question into that slot would also take away a
 * batch run's retry offer, which the graph counts as abandoning the run.
 *
 * So the overlay is a modal `<dialog>` of its own, in the top layer, and it is
 * a child of `<html>`, not of `<body>`: while `#dialog` stands, the graph makes
 * every child of `<body>` inert (`setBackgroundInert` in gitGraphView.ts),
 * including any that arrive later, and an inert overlay could not be answered.
 * Being modal, it makes the rest of the page inert in turn, `#dialog`
 * included, for as long as it is up; when the last prompt is answered, focus
 * goes back to where it was. Keys pressed in it stop at it: the graph's own
 * key handling would otherwise read an Enter or Escape meant for a prompt as
 * meant for `#dialog`.
 *
 * One prompt at a time, in the order they arrived (FIFO). */

import { svgIcons } from "@ging/webview/utils/icons";

import {
  type HostPrompt,
  type HostPromptAnswer,
  type HostPromptItem,
  type HostPromptLabels,
  type HostPromptMessage,
  matchingItems
} from "./hostPrompt";
import { HOST_PROMPT_STYLES } from "./hostPromptStyles";

export type HostPromptOverlay = {
  /** Show `message`'s prompt once those before it are answered. */
  enqueue(message: HostPromptMessage): void;
};

/** A prompt drawn into the overlay: what names it, its own keys, and where
 *  focus starts. */
type Drawn = {
  /** The text that says what is asked; a pick has none but its filter's. */
  title?: HTMLElement;
  keydown?(e: KeyboardEvent): void;
  focus(): void;
};

type Settle = (answer: HostPromptAnswer) => void;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const elem = document.createElement(tag);
  if (className !== undefined) elem.className = className;
  if (text !== undefined) elem.textContent = text;
  return elem;
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const elem = el("button", primary ? "roundedBtn primary" : "roundedBtn", label);
  elem.type = "button";
  elem.addEventListener("click", onClick);
  return elem;
}

function buttonRow(...buttons: HTMLButtonElement[]): HTMLElement {
  const row = el("div", "hostPromptButtons");
  row.append(...buttons);
  return row;
}

/** Enter that answers the prompt: not on a button, whose own Enter is a click,
 *  and not while an IME composition takes it. */
function answersWithEnter(e: KeyboardEvent): boolean {
  return e.key === "Enter" && !e.isComposing && !(e.target instanceof HTMLButtonElement);
}

function textInput(placeholder: string | undefined): HTMLInputElement {
  const input = el("input", "hostPromptText");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  if (placeholder !== undefined) input.placeholder = placeholder;
  return input;
}

function drawInput(
  root: HTMLElement,
  prompt: Extract<HostPrompt, { kind: "input" }>,
  labels: HostPromptLabels,
  settle: Settle
): Drawn {
  const message = el("label", "hostPromptMessage", prompt.prompt);
  const input = textInput(prompt.placeholder);
  input.id = "hostPromptInput";
  message.htmlFor = input.id;
  // Masked as a password field masks it; what is typed is never shown.
  if (prompt.password) input.type = "password";
  input.value = prompt.value ?? "";
  root.append(message, input);
  // The text answered last was refused: asked again from it, saying why.
  if (prompt.error !== undefined) {
    const why = el("div", "hostPromptError", prompt.error);
    why.id = "hostPromptError";
    why.setAttribute("role", "alert");
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", why.id);
    root.append(why);
  }
  root.append(
    buttonRow(
      button(labels.ok, () => settle(input.value), true),
      button(labels.cancel, () => settle(null))
    )
  );
  return {
    title: message,
    keydown: (e) => {
      if (!answersWithEnter(e)) return;
      e.preventDefault();
      settle(input.value);
    },
    focus: () => {
      input.focus();
      input.select();
    }
  };
}

function drawChoose(
  root: HTMLElement,
  prompt: Extract<HostPrompt, { kind: "choose" }>,
  labels: HostPromptLabels,
  settle: Settle
): Drawn {
  const message = el("div", "hostPromptMessage", prompt.message);
  root.append(message);
  if (prompt.detail !== undefined) root.append(el("div", "hostPromptDetail", prompt.detail));
  const actions = prompt.actions.map((label, index) =>
    button(label, () => settle(index), index === 0)
  );
  root.append(
    buttonRow(
      ...actions,
      button(labels.cancel, () => settle(null))
    )
  );
  return { title: message, focus: () => (actions[0] ?? root).focus() };
}

/** One row of a pick list: its label, its description, its detail under
 *  them, the warning mark, and a rule above it when it starts a group. */
function itemRow(item: HostPromptItem, index: number): HTMLLIElement {
  // A named group's rule is drawn with its name (`listRows`).
  const row = el(
    "li",
    item.separatorAbove === true ? "hostPromptItem separatorAbove" : "hostPromptItem"
  );
  row.id = `hostPromptItem${index}`;
  row.dataset.index = String(index);
  if (item.warning === true) {
    const mark = el("span", "hostPromptItemWarning");
    mark.innerHTML = svgIcons.alert;
    row.append(mark);
  }
  row.append(el("span", "hostPromptItemLabel", item.label));
  if (item.description !== undefined) {
    row.append(el("span", "hostPromptItemDescription", item.description));
  }
  if (item.detail !== undefined) row.append(el("span", "hostPromptItemDetail", item.detail));
  return row;
}

/** A named group's heading: its rule, and its name on it. */
type GroupName = { head: HTMLElement; from: number; to: number };

/** Put `rows` in `list`, each row that starts a named group (a string
 *  `separatorAbove`) under that name: answers the names, for the filter. */
function listRows(
  list: HTMLElement,
  items: readonly HostPromptItem[],
  rows: HTMLElement[]
): GroupName[] {
  const names: GroupName[] = [];
  rows.forEach((row, index) => {
    const above = items[index].separatorAbove;
    // A rule of either kind ends the group before it.
    const last = names.at(-1);
    if (above !== undefined && above !== false && last !== undefined && last.to > index) {
      last.to = index;
    }
    if (typeof above === "string") {
      // Not an option: the arrows and a click pass it by.
      const head = el("li", "hostPromptGroup", above);
      head.setAttribute("role", "presentation");
      names.push({ head, from: index, to: rows.length });
      list.append(head);
    }
    list.append(row);
  });
  return names;
}

/** A filter box over the rows of a list: typing hides the rows it no longer
 *  matches, and the name of a group none of whose rows match, and `onFilter`
 *  hears which rows still show. */
function filterOver(
  prompt: Extract<HostPrompt, { kind: "pick" | "pickMany" }>,
  rows: HTMLElement[],
  names: readonly GroupName[],
  onFilter: (visible: number[]) => void
): HTMLInputElement {
  const filter = textInput(prompt.placeholder);
  filter.className += " hostPromptFilter";
  // Named by what it asks, the placeholder being all there is to read.
  if (prompt.placeholder !== undefined) filter.setAttribute("aria-label", prompt.placeholder);
  filter.addEventListener("input", () => {
    const visible = matchingItems(prompt.items, filter.value, prompt.matchOnDescription);
    const shown = new Set(visible);
    rows.forEach((row, index) => {
      row.hidden = !shown.has(index);
    });
    for (const { head, from, to } of names) {
      head.hidden = !visible.some((index) => index >= from && index < to);
    }
    onFilter(visible);
  });
  return filter;
}

function drawPick(
  root: HTMLElement,
  prompt: Extract<HostPrompt, { kind: "pick" | "pickMany" }>,
  settle: Settle
): Drawn {
  const list = el("ul", "hostPromptList");
  list.id = "hostPromptList";
  list.setAttribute("role", "listbox");
  const rows = prompt.items.map((item, index) => {
    const row = itemRow(item, index);
    row.setAttribute("role", "option");
    row.addEventListener("click", () => settle(index));
    return row;
  });
  const names = listRows(list, prompt.items, rows);

  // The row Enter would choose: the first that shows, moved by the arrows.
  let visible = prompt.items.map((_, index) => index);
  let active = -1;
  const filter = filterOver(prompt, rows, names, (shown) => {
    visible = shown;
    activate(shown[0] ?? -1);
  });
  // Focus stays in the filter while the arrows move through the rows, so the
  // filter is the combobox that says which row is active.
  filter.setAttribute("role", "combobox");
  filter.setAttribute("aria-autocomplete", "list");
  filter.setAttribute("aria-expanded", "true");
  filter.setAttribute("aria-controls", list.id);
  function activate(index: number) {
    active = index;
    rows.forEach((row, i) => {
      row.classList.toggle("active", i === index);
      row.setAttribute("aria-selected", String(i === index));
    });
    const row = rows[index];
    if (row === undefined) {
      filter.removeAttribute("aria-activedescendant");
      return;
    }
    filter.setAttribute("aria-activedescendant", row.id);
    row.scrollIntoView({ block: "nearest" });
  }
  activate(visible[0] ?? -1);
  root.append(filter, list);

  return {
    keydown: (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (visible.length === 0) return;
        const at = visible.indexOf(active);
        const step = e.key === "ArrowDown" ? 1 : -1;
        activate(visible[(at + step + visible.length) % visible.length]);
      } else if (answersWithEnter(e)) {
        e.preventDefault();
        if (active !== -1) settle(active);
      }
    },
    focus: () => filter.focus()
  };
}

function drawPickMany(
  root: HTMLElement,
  prompt: Extract<HostPrompt, { kind: "pick" | "pickMany" }>,
  labels: HostPromptLabels,
  settle: Settle
): Drawn {
  const list = el("ul", "hostPromptList");
  const boxes: HTMLInputElement[] = [];
  const rows = prompt.items.map((item, index) => {
    const row = itemRow(item, index);
    const box = el("input");
    box.type = "checkbox";
    box.checked = item.picked === true;
    box.setAttribute("aria-label", item.label);
    boxes.push(box);
    row.prepend(box);
    // The whole row toggles its box, as a label would.
    row.addEventListener("click", (e) => {
      if (e.target !== box) box.checked = !box.checked;
    });
    return row;
  });
  const filter = filterOver(prompt, rows, listRows(list, prompt.items, rows), () => {});
  // Every row checked counts, whether the filter shows it or not.
  const checked = () => boxes.flatMap((box, index) => (box.checked ? [index] : []));
  root.append(
    filter,
    list,
    buttonRow(
      button(labels.ok, () => settle(checked()), true),
      button(labels.cancel, () => settle(null))
    )
  );
  return {
    keydown: (e) => {
      if (!answersWithEnter(e)) return;
      e.preventDefault();
      settle(checked());
    },
    focus: () => filter.focus()
  };
}

/**
 * The overlay, built into the page on its first prompt. `answer` hears each
 * prompt's answer by its id, `null` for one dismissed — with Escape or Cancel.
 */
export function createHostPromptOverlay(
  answer: (id: number, answer: HostPromptAnswer) => void
): HostPromptOverlay {
  const queue: HostPromptMessage[] = [];
  let shown: { id: number; drawn: Drawn } | null = null;
  let layer: HTMLDialogElement | null = null;
  /** What held focus when the overlay opened, to get it back when it closes. */
  let returnFocusTo: Element | null = null;
  /** Escape went down in the overlay: its keyup dismisses the prompt. */
  let escapeDown = false;

  const settle: Settle = (value) => {
    if (shown === null) return;
    const { id } = shown;
    shown = null;
    answer(id, value);
    showNext();
  };

  const build = (): HTMLDialogElement => {
    const style = el("style", undefined, HOST_PROMPT_STYLES);
    document.head.append(style);
    const dialog = el("dialog");
    dialog.id = "hostPrompt";
    // A child of <html>, not <body>: see the top of this file.
    document.documentElement.append(dialog);

    dialog.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" && !e.isComposing) {
        // Not the browser's own close of a modal dialog, which acts on this
        // keydown: dismissing here would leave the keyup to land on whatever
        // takes focus next, and the graph closes `#dialog` on Escape's keyup.
        e.preventDefault();
        escapeDown = true;
        return;
      }
      shown?.drawn.keydown?.(e);
    });
    dialog.addEventListener("keyup", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" && escapeDown) {
        escapeDown = false;
        settle(null);
      }
    });
    dialog.addEventListener("keypress", (e) => e.stopPropagation());
    // The graph's focus bookkeeping is for its own groups, not these.
    dialog.addEventListener("focusin", (e) => e.stopPropagation());
    // Closing is the overlay's to do, when the last prompt is answered.
    dialog.addEventListener("cancel", (e) => e.preventDefault());
    return dialog;
  };

  const restoreFocus = () => {
    const back = returnFocusTo;
    returnFocusTo = null;
    if (back instanceof HTMLElement && back.isConnected) {
      back.focus({ preventScroll: true });
      if (document.activeElement === back) return;
    }
    // What held focus is gone — the graph replaced its dialog's content while
    // the overlay stood — but the graph's dialog is still up: back to it.
    const graphDialog = document.getElementById("dialog");
    if (graphDialog?.classList.contains("active") === true) {
      graphDialog.focus({ preventScroll: true });
    }
  };

  function showNext() {
    const next = queue.shift();
    const dialog = layer;
    if (next === undefined) {
      if (dialog?.open === true) {
        dialog.close();
        dialog.replaceChildren();
        restoreFocus();
      }
      return;
    }
    const target = layer ?? (layer = build());
    target.replaceChildren();
    escapeDown = false;
    const { prompt, labels } = next;
    const drawn =
      prompt.kind === "input"
        ? drawInput(target, prompt, labels, settle)
        : prompt.kind === "choose"
          ? drawChoose(target, prompt, labels, settle)
          : prompt.kind === "pick"
            ? drawPick(target, prompt, settle)
            : drawPickMany(target, prompt, labels, settle);
    target.dataset.kind = prompt.kind;
    // Named by its question; a pick, which has none, by its filter's words.
    if (drawn.title !== undefined) {
      drawn.title.id = "hostPromptTitle";
      target.setAttribute("aria-labelledby", drawn.title.id);
    } else {
      target.removeAttribute("aria-labelledby");
    }
    const placeholder = "placeholder" in prompt ? prompt.placeholder : undefined;
    if (drawn.title === undefined && placeholder !== undefined) {
      target.setAttribute("aria-label", placeholder);
    } else {
      target.removeAttribute("aria-label");
    }
    shown = { id: next.id, drawn };
    if (!target.open) {
      returnFocusTo = document.activeElement;
      target.showModal();
    }
    drawn.focus();
  }

  return {
    enqueue: (message) => {
      queue.push(message);
      if (shown === null) showNext();
    }
  };
}
