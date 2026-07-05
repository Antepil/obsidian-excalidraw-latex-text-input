import { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";
import type { LatexSnippet } from "./latex-suite-snippets";
import { SNIPPET_VARIABLES } from "./latex-suite-snippets";

type MathContext = "text" | "inline" | "display";

const SNIPPET_USER_EVENT = "input.complete";

interface SnippetMatch {
  snippet: LatexSnippet;
  from: number;
  to: number;
  match: RegExpMatchArray | null;
  order: number;
}

interface PreparedReplacement {
  text: string;
  selectionFrom: number | null;
  selectionTo: number | null;
}

export function createLatexSnippetExtension(snippets: LatexSnippet[]): Extension {
  return [
    keymap.of([
      {
        key: "Tab",
        run: (view) => expandBestSnippet(view, snippets, false)
      }
    ]),
    ViewPlugin.fromClass(
      class {
        private timer: number | null = null;

        constructor(private readonly view: EditorView) {}

        update(update: ViewUpdate): void {
          if (!update.docChanged || !this.view.hasFocus) {
            return;
          }

          if (update.transactions.some((transaction) => transaction.isUserEvent(SNIPPET_USER_EVENT))) {
            return;
          }

          if (this.timer !== null) {
            window.clearTimeout(this.timer);
          }

          this.timer = window.setTimeout(() => {
            this.timer = null;
            expandBestSnippet(this.view, snippets, true);
          }, 0);
        }

        destroy(): void {
          if (this.timer !== null) {
            window.clearTimeout(this.timer);
          }
        }
      }
    )
  ];
}

function expandBestSnippet(
  view: EditorView,
  snippets: LatexSnippet[],
  autoOnly: boolean
): boolean {
  const snippetMatch = findBestSnippetMatch(view, snippets, autoOnly);
  if (!snippetMatch) {
    return false;
  }

  const replacement = prepareReplacement(snippetMatch.snippet, snippetMatch.match);
  const selection =
    replacement.selectionFrom === null || replacement.selectionTo === null
      ? undefined
      : {
          anchor: snippetMatch.from + replacement.selectionFrom,
          head: snippetMatch.from + replacement.selectionTo
        };

  view.dispatch({
    changes: {
      from: snippetMatch.from,
      to: snippetMatch.to,
      insert: replacement.text
    },
    selection,
    userEvent: SNIPPET_USER_EVENT
  });

  return true;
}

function findBestSnippetMatch(
  view: EditorView,
  snippets: LatexSnippet[],
  autoOnly: boolean
): SnippetMatch | null {
  const selection = view.state.selection.main;
  if (!selection.empty) {
    return null;
  }

  const cursor = selection.head;
  const textBeforeCursor = view.state.doc.sliceString(0, cursor);
  const context = getMathContext(textBeforeCursor);
  const matches: SnippetMatch[] = [];

  snippets.forEach((snippet, order) => {
    if (autoOnly && !snippet.options.includes("A")) {
      return;
    }

    if (!snippetAppliesToContext(snippet, context)) {
      return;
    }

    const match = matchSnippetTrigger(snippet, textBeforeCursor);
    if (!match) {
      return;
    }

    matches.push({
      snippet,
      from: cursor - match.length,
      to: cursor,
      match: match.regexMatch,
      order
    });
  });

  matches.sort((left, right) => {
    const priorityDelta = (right.snippet.priority ?? 0) - (left.snippet.priority ?? 0);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const lengthDelta = (right.to - right.from) - (left.to - left.from);
    if (lengthDelta !== 0) {
      return lengthDelta;
    }

    return left.order - right.order;
  });

  return matches[0] ?? null;
}

function snippetAppliesToContext(snippet: LatexSnippet, context: MathContext): boolean {
  const options = snippet.options;
  const textAllowed = options.includes("t");
  const inlineAllowed = options.includes("n");
  const displayAllowed = options.includes("M");
  const mathAllowed = options.includes("m") || inlineAllowed || displayAllowed;

  if (displayAllowed && context === "display") {
    return true;
  }

  if (inlineAllowed && context === "inline") {
    return true;
  }

  if (mathAllowed && !inlineAllowed && !displayAllowed && context !== "text") {
    return true;
  }

  if (textAllowed && context === "text") {
    return true;
  }

  return !textAllowed && !mathAllowed;
}

function matchSnippetTrigger(
  snippet: LatexSnippet,
  textBeforeCursor: string
): { length: number; regexMatch: RegExpMatchArray | null } | null {
  if (snippet.trigger instanceof RegExp || snippet.options.includes("r")) {
    const regex = snippet.trigger instanceof RegExp
      ? snippet.trigger
      : new RegExp(expandSnippetVariables(snippet.trigger));
    const anchored = new RegExp(`${regex.source}$`, regex.flags.replace(/[gy]/g, ""));
    const match = anchored.exec(textBeforeCursor);

    if (!match) {
      return null;
    }

    return {
      length: match[0].length,
      regexMatch: match
    };
  }

  if (!textBeforeCursor.endsWith(snippet.trigger)) {
    return null;
  }

  return {
    length: snippet.trigger.length,
    regexMatch: null
  };
}

function prepareReplacement(
  snippet: LatexSnippet,
  match: RegExpMatchArray | null
): PreparedReplacement {
  const rawReplacement =
    typeof snippet.replacement === "function"
      ? snippet.replacement(match ?? ([""] as unknown as RegExpMatchArray))
      : snippet.replacement;
  const withMatchGroups = rawReplacement.replace(/\[\[(\d+)]]/g, (_, index: string) => {
    return match?.[Number(index) + 1] ?? "";
  });

  return resolvePlaceholders(withMatchGroups);
}

function resolvePlaceholders(replacement: string): PreparedReplacement {
  let text = "";
  let cursor = 0;
  let selectionFrom: number | null = null;
  let selectionTo: number | null = null;

  const placeholderPattern = /\$\{VISUAL}|\$\{(\d+):([^}]*)}|\$(\d+)/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = placeholderPattern.exec(replacement)) !== null) {
    const literal = replacement.slice(lastIndex, match.index);
    text += literal;
    cursor += literal.length;

    const defaultValue = match[2] ?? "";
    if (selectionFrom === null) {
      selectionFrom = cursor;
      selectionTo = cursor + defaultValue.length;
    }

    text += defaultValue;
    cursor += defaultValue.length;
    lastIndex = placeholderPattern.lastIndex;
  }

  text += replacement.slice(lastIndex);

  return {
    text,
    selectionFrom,
    selectionTo
  };
}

function expandSnippetVariables(pattern: string): string {
  return pattern.replace(/\$\{([A-Z_]+)}/g, (_, name: string) => {
    return SNIPPET_VARIABLES[name] ?? "";
  });
}

function getMathContext(textBeforeCursor: string): MathContext {
  let context: MathContext = "text";

  for (let index = 0; index < textBeforeCursor.length; index += 1) {
    if (textBeforeCursor[index] !== "$" || isEscaped(textBeforeCursor, index)) {
      continue;
    }

    if (textBeforeCursor[index + 1] === "$") {
      context = context === "display" ? "text" : "display";
      index += 1;
      continue;
    }

    if (context !== "display") {
      context = context === "inline" ? "text" : "inline";
    }
  }

  return context;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  let cursor = index - 1;

  while (cursor >= 0 && text[cursor] === "\\") {
    slashCount += 1;
    cursor -= 1;
  }

  return slashCount % 2 === 1;
}
