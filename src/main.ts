import { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Language, defineLanguageFacet } from "@codemirror/language";
import {
  Input,
  NodeSet,
  NodeType,
  Parser,
  PartialParse,
  Tree,
  TreeFragment
} from "@lezer/common";
import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon
} from "obsidian";
import { createLatexSnippetExtension } from "./latex-snippet-extension";
import latexSuiteSnippets from "./latex-suite-snippets";

interface ExcalidrawLatexTextSettings {
  defaultTextWidth: number;
  replaceSelectedText: boolean;
  renderInlineLatexOnInsert: boolean;
}

interface LatexSuiteApi {
  editorExtensions?: Extension[];
}

interface PluginRegistry {
  plugins?: Record<string, unknown>;
}

interface AppWithPlugins extends App {
  plugins?: PluginRegistry;
}

interface ExcalidrawElement {
  id: string;
  type: string;
  text?: string;
  rawText?: string;
  originalText?: string;
  containerId?: string | null;
  boundElements?: Array<{ type: string; id: string }> | null;
  startBinding?: { elementId?: string; [key: string]: unknown } | null;
  endBinding?: { elementId?: string; [key: string]: unknown } | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  strokeColor?: string;
  backgroundColor?: string;
  opacity?: number;
  [key: string]: unknown;
}

interface ExcalidrawApi {
  getAppState?: () => Record<string, unknown>;
  getSceneElements?: () => ExcalidrawElement[];
  updateScene?: (scene: Record<string, unknown>) => void;
}

interface ExcalidrawAutomateApi {
  reset?: () => void;
  setView?: (view?: unknown, show?: boolean) => unknown;
  addRect?: (
    x: number,
    y: number,
    width: number,
    height: number
  ) => string | null;
  addText?: (
    x: number,
    y: number,
    text: string,
    options?: Record<string, unknown>
  ) => string | null;
  addLaTex?: (
    x: number,
    y: number,
    latex: string,
    scale?: number,
    fontSize?: number
  ) => Promise<string | null> | string | null;
  addElementsToView?: (
    repositionToCursor?: boolean,
    save?: boolean,
    newElementsOnTop?: boolean
  ) => Promise<boolean> | boolean;
  copyViewElementsToEAforEditing?: (elements: ExcalidrawElement[]) => void;
  deleteViewElements?: (elements: ExcalidrawElement[]) => void;
  selectElementsInView?: (ids: string[] | ExcalidrawElement[]) => void;
  addToGroup?: (ids: string[] | ExcalidrawElement[]) => void;
  getElement?: (id: string) => ExcalidrawElement | null;
  getViewElements?: () => ExcalidrawElement[];
  getViewSelectedElements?: () => ExcalidrawElement[];
  getViewCenterPosition?: () => { x: number; y: number } | null;
  getExcalidrawAPI?: () => ExcalidrawApi;
  style?: Record<string, unknown>;
}

interface InsertContext {
  ea: ExcalidrawAutomateApi;
  view: unknown;
  selectedTextElement: ExcalidrawElement | null;
  initialStyle: TextStyleSelection;
  latexSuiteAvailable: boolean;
}

type TextAlign = "left" | "center" | "right";

interface TextStyleSelection {
  strokeColor: string;
  fontSize: number;
  textAlign: TextAlign;
}

interface InlineTextStyle extends TextStyleSelection {
  fontFamily: number;
  verticalAlign: string;
  lineHeight: number;
}

type InlineLatexFragment =
  | { type: "text"; value: string }
  | { type: "latex"; value: string };

interface InlineBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface InlineInsertResult {
  ids: string[];
  bounds: InlineBounds | null;
}

interface InlineConversionOverride {
  text?: string;
  style?: TextStyleSelection;
}

interface ModalOptions {
  initialText: string;
  initialStyle: TextStyleSelection;
  latexSuiteExtensions: Extension[];
  onSubmit: (text: string, style: TextStyleSelection) => Promise<void>;
}

const DEFAULT_SETTINGS: ExcalidrawLatexTextSettings = {
  defaultTextWidth: 500,
  replaceSelectedText: true,
  renderInlineLatexOnInsert: true
};

const DOCUMENT_NODE_ID = 0;
const OPEN_INLINE_MATH_NODE_ID = 1;
const CLOSE_MATH_NODE_ID = 2;
const OPEN_DISPLAY_MATH_NODE_ID = 3;
const DOCUMENT_NODE = "Document";
const OPEN_INLINE_MATH_NODE = "formatting_formatting-math_formatting-math-begin_keyword_math";
const CLOSE_MATH_NODE = "formatting_formatting-math_formatting-math-end_keyword_math_math-";
const OPEN_DISPLAY_MATH_NODE = "formatting_formatting-math_formatting-math-begin_keyword_math_math-block";
const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";
const LATEX_SUITE_PLUGIN_ID = "obsidian-latex-suite";
const INLINE_FRAGMENT_GAP = 0;
const INLINE_ANCHOR_PADDING = 4;
const CONTAINER_PADDING_FALLBACK = 12;
const DEFAULT_FONT_FAMILY = 5;
const DEFAULT_LINE_HEIGHT = 1.25;
const DEFAULT_TEXT_STYLE: TextStyleSelection = {
  strokeColor: "#1e1e1e",
  fontSize: 20,
  textAlign: "left"
};
const STROKE_OPTIONS = [
  { label: "Black", value: "#1e1e1e" },
  { label: "Red", value: "#e03131" },
  { label: "Green", value: "#2f9e44" },
  { label: "Blue", value: "#1971c2" },
  { label: "Orange", value: "#f08c00" },
  { label: "Purple", value: "#9c36b5" }
];
const FONT_SIZE_OPTIONS = [
  { label: "XS", value: 16 },
  { label: "S", value: 20 },
  { label: "M", value: 28 },
  { label: "L", value: 36 },
  { label: "XL", value: 48 }
];
const TEXT_ALIGN_OPTIONS: Array<{ label: string; value: TextAlign; icon: string }> = [
  { label: "Left", value: "left", icon: "align-left" },
  { label: "Center", value: "center", icon: "align-center" },
  { label: "Right", value: "right", icon: "align-right" }
];

export default class ExcalidrawLatexTextInputPlugin extends Plugin {
  settings!: ExcalidrawLatexTextSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "insert-enhanced-text",
      name: "Insert enhanced text into Excalidraw",
      checkCallback: (checking) => {
        const view = getActiveExcalidrawView(this.app);
        if (!view) {
          return false;
        }

        if (!checking) {
          this.openInputModal(view);
        }

        return true;
      }
    });

    this.addCommand({
      id: "convert-selected-inline-latex",
      name: "Convert selected text to inline LaTeX",
      checkCallback: (checking) => {
        const view = getActiveExcalidrawView(this.app);
        if (!view) {
          return false;
        }

        if (!checking) {
          void this.convertSelectedInlineLatex(view);
        }

        return true;
      }
    });

    this.addSettingTab(new ExcalidrawLatexTextSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private openInputModal(view: unknown): void {
    const context = this.getInsertContext(view);
    if (!context) {
      return;
    }

    const initialText = context.selectedTextElement?.text ?? "";

    if (!context.latexSuiteAvailable) {
      new Notice("LaTeX Suite is not available. Opening plain text input.");
    }

    new MixedLatexTextModal(this.app, {
      initialText,
      initialStyle: context.initialStyle,
      latexSuiteExtensions: getLatexSuiteExtensions(this.app),
      onSubmit: async (text, style) => {
        await this.insertIntoExcalidraw(text, style, context);
      }
    }).open();
  }

  private getInsertContext(view: unknown): InsertContext | null {
    const ea = getExcalidrawAutomate();
    if (!ea) {
      new Notice("ExcalidrawAutomate is not available. Enable the Excalidraw plugin first.");
      return null;
    }

    if (!isPluginEnabled(this.app, EXCALIDRAW_PLUGIN_ID)) {
      new Notice("Excalidraw plugin is not enabled.");
      return null;
    }

    if (!setExcalidrawAutomateView(ea, view)) {
      new Notice("Could not target the active Excalidraw view.");
      return null;
    }

    const selectedTextElement = this.settings.replaceSelectedText
      ? getSingleSelectedTextElement(ea)
      : null;

    return {
      ea,
      view,
      selectedTextElement,
      initialStyle: getInitialTextStyle(ea, selectedTextElement),
      latexSuiteAvailable: getLatexSuiteExtensions(this.app).length > 0
    };
  }

  private async insertIntoExcalidraw(
    text: string,
    style: TextStyleSelection,
    context: InsertContext
  ): Promise<void> {
    const normalizedText = text.trimEnd();
    if (!normalizedText) {
      new Notice("Nothing to insert.");
      return;
    }

    if (this.settings.renderInlineLatexOnInsert && hasLatexFragment(parseInlineLatex(normalizedText))) {
      if (context.selectedTextElement && this.settings.replaceSelectedText) {
        const didReplace = await replaceTextElementWithInlineLatex(
          context.ea,
          context.view,
          context.selectedTextElement,
          normalizedText,
          style
        );
        if (didReplace) {
          new Notice("Inserted inline LaTeX text.");
          return;
        }

        new Notice("Could not convert the selected text. Creating new inline LaTeX text instead.");
      }

      const didInsertInline = await insertNewInlineLatexElements(
        context.ea,
        context.view,
        normalizedText,
        style,
        this.settings.defaultTextWidth
      );

      if (didInsertInline) {
        new Notice("Inserted inline LaTeX text.");
        return;
      }

      new Notice("Could not insert inline LaTeX. Creating a normal text element instead.");
    }

    if (context.selectedTextElement && this.settings.replaceSelectedText) {
      const didReplace = await replaceTextElement(
        context.ea,
        context.view,
        context.selectedTextElement,
        normalizedText,
        style
      );
      if (didReplace) {
        new Notice("Updated Excalidraw text.");
        return;
      }

      new Notice("Could not update the selected text. Creating a new text element instead.");
    }

    const didInsert = await insertNewTextElement(
      context.ea,
      context.view,
      normalizedText,
      style,
      this.settings.defaultTextWidth
    );

    if (!didInsert) {
      new Notice("Could not insert text into the active Excalidraw view.");
      return;
    }

    new Notice("Inserted Excalidraw text.");
  }

  private async convertSelectedInlineLatex(view: unknown): Promise<void> {
    const context = this.getInsertContext(view);
    if (!context) {
      return;
    }

    const selectedTextElements = getSelectedTextElements(context.ea);
    if (selectedTextElements.length === 0) {
      new Notice("Select one or more Excalidraw text elements first.");
      return;
    }

    const convertedCount = await convertTextElementsToInlineLatex(
      context.ea,
      context.view,
      selectedTextElements
    );

    if (convertedCount > 0) {
      new Notice(
        convertedCount === 1
          ? "Converted one text element to inline LaTeX."
          : `Converted ${convertedCount} text elements to inline LaTeX.`
      );
    }
  }
}

class MixedLatexTextModal extends Modal {
  private editorView: EditorView | null = null;
  private textStyle: TextStyleSelection;

  constructor(app: App, private readonly options: ModalOptions) {
    super(app);
    this.textStyle = { ...options.initialStyle };
  }

  onOpen(): void {
    this.modalEl.addClass("excalidraw-latex-text-modal");
    this.titleEl.setText("Enhanced Excalidraw Text");
    this.contentEl.empty();

    const editorHost = this.contentEl.createDiv({
      cls: "excalidraw-latex-text-editor"
    });

    this.createStyleControls();

    const footer = this.contentEl.createDiv({
      cls: "excalidraw-latex-text-footer"
    });

    const cancelButton = footer.createEl("button", {
      text: "Cancel",
      type: "button"
    });
    cancelButton.addEventListener("click", () => this.close());

    const insertButton = footer.createEl("button", {
      text: "Insert",
      type: "button",
      cls: "mod-cta"
    });
    insertButton.addEventListener("click", () => {
      void this.submit();
    });

    this.editorView = new EditorView({
      state: EditorState.create({
        doc: this.options.initialText,
        extensions: [
          EditorView.lineWrapping,
          EditorView.theme({
            "&": {
              minHeight: "44px"
            },
            ".cm-scroller": {
              fontFamily: "var(--font-text)",
              maxHeight: "320px",
              overflow: "auto"
            }
          }),
          keymap.of([
            {
              key: "Shift-Enter",
              run: (view) => {
                insertEditorLineBreak(view);
                return true;
              }
            },
            {
              key: "Enter",
              run: (view) => {
                if (view.composing) {
                  return false;
                }

                void this.submit();
                return true;
              }
            },
            {
              key: "Mod-Enter",
              run: () => {
                void this.submit();
                return true;
              }
            },
            {
              key: "Escape",
              run: () => {
                this.close();
                return true;
              }
            }
          ]),
          createLatexSnippetExtension(latexSuiteSnippets),
          latexSuiteMarkdownLanguage.extension,
          ...this.options.latexSuiteExtensions
        ]
      }),
      parent: editorHost
    });

    window.setTimeout(() => this.editorView?.focus(), 0);
  }

  private createStyleControls(): void {
    const panel = this.contentEl.createDiv({
      cls: "excalidraw-latex-text-style-panel"
    });

    this.createStrokeControls(panel);
    this.createFontSizeControls(panel);
    this.createTextAlignControls(panel);
  }

  private createStrokeControls(panel: HTMLElement): void {
    const group = createStyleSection(panel, "Stroke", "excalidraw-latex-text-swatches");

    for (const option of STROKE_OPTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "excalidraw-latex-text-swatch";
      button.dataset.value = option.value;
      button.setAttribute("aria-label", option.label);
      button.setAttribute("title", option.label);
      button.style.setProperty("--swatch-color", option.value);
      button.addEventListener("click", () => {
        this.textStyle.strokeColor = option.value;
        markSelectedStyleButton(group, option.value);
        this.editorView?.focus();
      });
      group.appendChild(button);
    }

    markSelectedStyleButton(group, this.textStyle.strokeColor);
  }

  private createFontSizeControls(panel: HTMLElement): void {
    const group = createStyleSection(panel, "Font size", "excalidraw-latex-text-segments");

    for (const option of FONT_SIZE_OPTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "excalidraw-latex-text-segment";
      button.dataset.value = String(option.value);
      button.textContent = option.label;
      button.addEventListener("click", () => {
        this.textStyle.fontSize = option.value;
        markSelectedStyleButton(group, String(option.value));
        this.editorView?.focus();
      });
      group.appendChild(button);
    }

    markSelectedStyleButton(group, String(this.textStyle.fontSize));
  }

  private createTextAlignControls(panel: HTMLElement): void {
    const group = createStyleSection(panel, "Text align", "excalidraw-latex-text-segments");

    for (const option of TEXT_ALIGN_OPTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "excalidraw-latex-text-segment excalidraw-latex-text-icon-segment";
      button.dataset.value = option.value;
      button.setAttribute("aria-label", option.label);
      button.setAttribute("title", option.label);
      setIcon(button, option.icon);
      button.addEventListener("click", () => {
        this.textStyle.textAlign = option.value;
        markSelectedStyleButton(group, option.value);
        this.editorView?.focus();
      });
      group.appendChild(button);
    }

    markSelectedStyleButton(group, this.textStyle.textAlign);
  }

  onClose(): void {
    this.editorView?.destroy();
    this.editorView = null;
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (!this.editorView) {
      return;
    }

    const text = this.editorView.state.doc.toString();
    const style = { ...this.textStyle };
    this.close();
    await this.options.onSubmit(text, style);
  }
}

class ExcalidrawLatexTextSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ExcalidrawLatexTextInputPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default text width")
      .setDesc("Width used when creating a new Excalidraw text element.")
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.defaultTextWidth))
          .setValue(String(this.plugin.settings.defaultTextWidth))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed <= 0) {
              return;
            }

            this.plugin.settings.defaultTextWidth = Math.round(parsed);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Replace selected text")
      .setDesc("When a single Excalidraw text element is selected, edit that element instead of creating a new one.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.replaceSelectedText)
          .onChange(async (value) => {
            this.plugin.settings.replaceSelectedText = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Render inline LaTeX on insert")
      .setDesc("When enabled, text inside math delimiters is inserted as Excalidraw LaTeX elements while surrounding text remains normal text.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.renderInlineLatexOnInsert)
          .onChange(async (value) => {
            this.plugin.settings.renderInlineLatexOnInsert = value;
            await this.plugin.saveSettings();
          });
      });
  }
}

function insertEditorLineBreak(view: EditorView): void {
  const selection = view.state.selection.main;
  const anchor = selection.from + 1;

  view.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert: "\n"
    },
    selection: {
      anchor
    },
    userEvent: "input"
  });
}

function createStyleSection(
  panel: HTMLElement,
  label: string,
  groupClassName: string
): HTMLElement {
  const section = panel.createDiv({
    cls: "excalidraw-latex-text-style-section"
  });
  section.createDiv({
    cls: "excalidraw-latex-text-style-label",
    text: label
  });

  return section.createDiv({
    cls: `excalidraw-latex-text-style-group ${groupClassName}`
  });
}

function markSelectedStyleButton(group: HTMLElement, value: string): void {
  for (const button of Array.from(group.querySelectorAll("button"))) {
    button.toggleClass("is-selected", button.dataset.value === value);
  }
}

function getActiveExcalidrawView(app: App): unknown | null {
  const leaf = app.workspace.activeLeaf;
  if (!leaf) {
    return null;
  }

  const view = leaf.view as unknown as {
    getViewType?: () => string;
    containerEl?: HTMLElement;
  };

  const viewType = view.getViewType?.().toLowerCase() ?? "";
  if (viewType.includes("excalidraw")) {
    return view;
  }

  if (view.containerEl?.querySelector(".excalidraw")) {
    return view;
  }

  return null;
}

const latexSuiteMarkdownNodeSet = new NodeSet([
  NodeType.define({
    id: DOCUMENT_NODE_ID,
    name: DOCUMENT_NODE,
    top: true
  }),
  NodeType.define({
    id: OPEN_INLINE_MATH_NODE_ID,
    name: OPEN_INLINE_MATH_NODE
  }),
  NodeType.define({
    id: CLOSE_MATH_NODE_ID,
    name: CLOSE_MATH_NODE
  }),
  NodeType.define({
    id: OPEN_DISPLAY_MATH_NODE_ID,
    name: OPEN_DISPLAY_MATH_NODE
  })
]);

class LatexSuiteMarkdownParser extends Parser {
  createParse(
    input: Input,
    _fragments: readonly TreeFragment[],
    _ranges: readonly { from: number; to: number }[]
  ): PartialParse {
    const tree = buildLatexSuiteMarkdownTree(input.read(0, input.length));
    let isDone = false;

    return {
      parsedPos: input.length,
      stoppedAt: null,
      stopAt: () => undefined,
      advance: () => {
        if (isDone) {
          return tree;
        }

        isDone = true;
        return tree;
      }
    };
  }
}

const latexSuiteMarkdownLanguage = new Language(
  defineLanguageFacet(),
  new LatexSuiteMarkdownParser(),
  [],
  "markdown"
);

function buildLatexSuiteMarkdownTree(text: string): Tree {
  const nodes: number[] = [];
  let index = 0;

  while (index < text.length) {
    const delimiter = findNextMathDelimiter(text, index);
    if (!delimiter) {
      break;
    }

    const close = findClosingMathDelimiter(
      text,
      delimiter.to,
      delimiter.marker
    );
    if (!close) {
      break;
    }

    nodes.push(delimiter.nodeId, delimiter.from, delimiter.to, 4);
    nodes.push(CLOSE_MATH_NODE_ID, close.from, close.to, 4);
    index = close.to;
  }

  const nodeCount = nodes.length / 4 + 1;
  nodes.push(DOCUMENT_NODE_ID, 0, text.length, nodeCount * 4);

  return Tree.build({
    buffer: nodes,
    nodeSet: latexSuiteMarkdownNodeSet,
    topID: DOCUMENT_NODE_ID,
    length: text.length
  });
}

function findNextMathDelimiter(
  text: string,
  from: number
): { from: number; to: number; marker: "$" | "$$"; nodeId: number } | null {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] !== "$" || isEscaped(text, index)) {
      continue;
    }

    if (text[index + 1] === "$") {
      return {
        from: index,
        to: index + 2,
        marker: "$$",
        nodeId: OPEN_DISPLAY_MATH_NODE_ID
      };
    }

    return {
      from: index,
      to: index + 1,
      marker: "$",
      nodeId: OPEN_INLINE_MATH_NODE_ID
    };
  }

  return null;
}

function findClosingMathDelimiter(
  text: string,
  from: number,
  marker: "$" | "$$"
): { from: number; to: number } | null {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] !== "$" || isEscaped(text, index)) {
      continue;
    }

    if (marker === "$$") {
      if (text[index + 1] === "$") {
        return {
          from: index,
          to: index + 2
        };
      }

      continue;
    }

    if (text[index + 1] !== "$") {
      return {
        from: index,
        to: index + 1
      };
    }
  }

  return null;
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

function getLatexSuiteExtensions(app: App): Extension[] {
  const plugin = getPlugin(app, LATEX_SUITE_PLUGIN_ID) as LatexSuiteApi | null;
  return Array.isArray(plugin?.editorExtensions) ? plugin.editorExtensions : [];
}

function isPluginEnabled(app: App, pluginId: string): boolean {
  return Boolean(getPlugin(app, pluginId));
}

function getPlugin(app: App, pluginId: string): unknown | null {
  return (app as AppWithPlugins).plugins?.plugins?.[pluginId] ?? null;
}

function getExcalidrawAutomate(): ExcalidrawAutomateApi | null {
  const currentWindow = window.activeWindow ?? window;
  const candidate =
    (currentWindow as Window & { ExcalidrawAutomate?: unknown }).ExcalidrawAutomate ??
    (window as Window & { ExcalidrawAutomate?: unknown }).ExcalidrawAutomate;
  return isObject(candidate) ? (candidate as ExcalidrawAutomateApi) : null;
}

function getSingleSelectedTextElement(ea: ExcalidrawAutomateApi): ExcalidrawElement | null {
  try {
    const selected = ea.getViewSelectedElements?.() ?? [];
    if (selected.length === 1 && selected[0]?.type === "text") {
      return selected[0];
    }
  } catch (error) {
    console.warn("Could not read selected Excalidraw elements.", error);
  }

  return null;
}

function getInitialTextStyle(
  ea: ExcalidrawAutomateApi,
  selectedTextElement: ExcalidrawElement | null
): TextStyleSelection {
  const appState = safeGetExcalidrawApi(ea)?.getAppState?.() ?? {};
  const strokeColor =
    getStringValue(selectedTextElement?.strokeColor) ??
    getStringValue(appState.currentItemStrokeColor) ??
    getStringValue(ea.style?.strokeColor) ??
    DEFAULT_TEXT_STYLE.strokeColor;
  const fontSize =
    getClosestFontSize(
      getNumberValue(selectedTextElement?.fontSize) ??
      getNumberValue(appState.currentItemFontSize) ??
      getNumberValue(ea.style?.fontSize) ??
      DEFAULT_TEXT_STYLE.fontSize
    );
  const textAlign =
    getTextAlign(selectedTextElement?.textAlign) ??
    getTextAlign(appState.currentItemTextAlign) ??
    getTextAlign(ea.style?.textAlign) ??
    DEFAULT_TEXT_STYLE.textAlign;

  return {
    strokeColor,
    fontSize,
    textAlign
  };
}

function getClosestFontSize(value: number): number {
  return FONT_SIZE_OPTIONS.reduce((closest, option) => {
    return Math.abs(option.value - value) < Math.abs(closest - value) ? option.value : closest;
  }, FONT_SIZE_OPTIONS[0].value);
}

function getTextAlign(value: unknown): TextAlign | null {
  return value === "left" || value === "center" || value === "right" ? value : null;
}

function getStringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function getNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const shouldJoinWithoutSpace = (before: string, after: string): boolean => {
  const cjkOrFullWidth = /[\u3400-\u9fff\uff00-\uffef，。！？；：、（）【】《》“”‘’]/u;
  return cjkOrFullWidth.test(before) || cjkOrFullWidth.test(after);
};

function normalizeTextFragment(text: string): string {
  return text
    .replace(/\\\$/g, "$")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]*\n+[ \t]*/g, (match, offset, source) => {
      const before = source[offset - 1] ?? "";
      const after = source[offset + match.length] ?? "";
      return shouldJoinWithoutSpace(before, after) ? "" : " ";
    })
    .replace(/[ \t]{2,}/g, " ");
}

function normalizeLatexFragment(latex: string): string {
  return latex.replace(/\s+/g, " ").trim();
}

function parseInlineLatex(text: string): InlineLatexFragment[] {
  const fragments: InlineLatexFragment[] = [];
  let buffer = "";
  let index = 0;

  const pushText = () => {
    const value = normalizeTextFragment(buffer);
    if (value) {
      fragments.push({ type: "text", value });
    }
    buffer = "";
  };

  while (index < text.length) {
    if (text[index] !== "$" || isEscaped(text, index)) {
      buffer += text[index];
      index += 1;
      continue;
    }

    const delimiter = text[index + 1] === "$" ? "$$" : "$";
    const start = index + delimiter.length;
    let end = -1;

    for (let cursor = start; cursor < text.length; cursor += 1) {
      if (
        text.slice(cursor, cursor + delimiter.length) === delimiter &&
        !isEscaped(text, cursor)
      ) {
        end = cursor;
        break;
      }
    }

    if (end === -1) {
      buffer += text[index];
      index += 1;
      continue;
    }

    pushText();
    const latex = normalizeLatexFragment(text.slice(start, end));
    if (latex) {
      fragments.push({ type: "latex", value: latex });
    }
    index = end + delimiter.length;
  }

  pushText();
  return fragments;
}

function hasLatexFragment(fragments: InlineLatexFragment[]): boolean {
  return fragments.some((fragment) => fragment.type === "latex");
}

async function replaceTextElementWithInlineLatex(
  ea: ExcalidrawAutomateApi,
  view: unknown,
  element: ExcalidrawElement,
  text: string,
  style: TextStyleSelection
): Promise<boolean> {
  const convertedCount = await convertTextElementsToInlineLatex(
    ea,
    view,
    [element],
    new Map([[element.id, { text, style }]])
  );
  return convertedCount > 0;
}

async function insertNewInlineLatexElements(
  ea: ExcalidrawAutomateApi,
  view: unknown,
  text: string,
  style: TextStyleSelection,
  width: number
): Promise<boolean> {
  if (!ea.addText || !ea.addLaTex || !ea.addElementsToView || !ea.getElement) {
    return false;
  }

  try {
    if (!setExcalidrawAutomateView(ea, view)) {
      return false;
    }

    const api = safeGetExcalidrawApi(ea);
    const appState = api?.getAppState?.() ?? {};
    ea.reset?.();
    applyCurrentTextStyle(ea, appState);

    const renderStyle = getInlineTextStyle(ea, null, style);
    const point = ea.getViewCenterPosition?.() ?? getViewportCenterScenePoint(view, appState);
    const result = await insertInlineLinesInArea(
      ea,
      text,
      {
        x: point.x,
        y: point.y,
        width
      },
      renderStyle
    );

    if (result.ids.length === 0) {
      return false;
    }

    groupElements(ea, result.ids);
    const didAdd = await Promise.resolve(ea.addElementsToView(false, false, true));
    if (didAdd !== false) {
      selectElements(ea, result.ids);
      return true;
    }

    return false;
  } catch (error) {
    console.warn("Could not insert inline LaTeX through ExcalidrawAutomate.", error);
    return false;
  }
}

async function convertTextElementsToInlineLatex(
  ea: ExcalidrawAutomateApi,
  view: unknown,
  textElements: ExcalidrawElement[],
  overrides: Map<string, InlineConversionOverride> = new Map()
): Promise<number> {
  if (
    !ea.addText ||
    !ea.addLaTex ||
    !ea.addElementsToView ||
    !ea.deleteViewElements ||
    !ea.getElement ||
    !ea.getViewElements
  ) {
    return 0;
  }

  if (!setExcalidrawAutomateView(ea, view)) {
    return 0;
  }

  ea.reset?.();

  const convertedIds: string[] = [];
  const originalsToDelete: ExcalidrawElement[] = [];
  const bindingTargetIdsByOriginalId = new Map<string, string>();
  const connectedLinesByTextId = getConnectedLinesByElementId(
    ea,
    textElements.map((element) => element.id)
  );
  let skippedNoLatexCount = 0;
  let skippedMissingContainerCount = 0;

  for (const textElement of textElements) {
    const override = overrides.get(textElement.id);
    const sourceText = override?.text ?? textElement.text ?? "";
    const fragments = parseInlineLatex(sourceText);
    if (!hasLatexFragment(fragments)) {
      skippedNoLatexCount += 1;
      continue;
    }

    const style = getInlineTextStyle(ea, textElement, override?.style);
    const draftTextElement = override?.style
      ? withUpdatedTextAndStyle(textElement, sourceText, override.style)
      : { ...textElement, text: sourceText };
    const connectedLines = connectedLinesByTextId.get(textElement.id) ?? [];

    if (draftTextElement.containerId) {
      const containerElement = getViewElementById(ea, draftTextElement.containerId);
      if (!containerElement) {
        skippedMissingContainerCount += 1;
        continue;
      }

      const result = await insertInlineLinesInContainer(
        ea,
        draftTextElement,
        containerElement,
        style
      );
      if (result.ids.length === 0) {
        continue;
      }

      ea.copyViewElementsToEAforEditing?.([containerElement]);
      const editableContainer = ea.getElement(containerElement.id);
      if (!editableContainer) {
        skippedMissingContainerCount += 1;
        continue;
      }

      addBoundLinesToElement(editableContainer, connectedLines);

      const ids = [editableContainer.id, ...result.ids];
      groupElements(ea, ids);

      if (connectedLines.length > 0) {
        bindingTargetIdsByOriginalId.set(textElement.id, editableContainer.id);
      }

      convertedIds.push(...ids);
      originalsToDelete.push(textElement);
      continue;
    }

    const result = await insertInlineTextForElement(ea, draftTextElement, style);
    if (result.ids.length === 0) {
      continue;
    }

    let ids = result.ids;
    if (connectedLines.length > 0 && result.bounds) {
      const anchorId = createTransparentAnchor(ea, result.bounds, connectedLines);
      if (!anchorId) {
        continue;
      }

      bindingTargetIdsByOriginalId.set(textElement.id, anchorId);
      ids = [anchorId, ...result.ids];
    }

    groupElements(ea, ids);
    convertedIds.push(...ids);
    originalsToDelete.push(textElement);
  }

  if (bindingTargetIdsByOriginalId.size > 0) {
    const linesToEditById = new Map<string, ExcalidrawElement>();
    for (const connectedLines of connectedLinesByTextId.values()) {
      for (const { line } of connectedLines) {
        linesToEditById.set(line.id, line);
      }
    }

    ea.copyViewElementsToEAforEditing?.([...linesToEditById.values()]);

    for (const [oldId, targetId] of bindingTargetIdsByOriginalId.entries()) {
      for (const { line, side } of connectedLinesByTextId.get(oldId) ?? []) {
        const editableLine = ea.getElement(line.id);
        if (!editableLine) {
          continue;
        }

        if (side === "start" && editableLine.startBinding?.elementId === oldId) {
          editableLine.startBinding.elementId = targetId;
        }

        if (side === "end" && editableLine.endBinding?.elementId === oldId) {
          editableLine.endBinding.elementId = targetId;
        }
      }
    }
  }

  if (originalsToDelete.length === 0) {
    showInlineConversionSkipNotices(skippedNoLatexCount, skippedMissingContainerCount);
    return 0;
  }

  ea.deleteViewElements(originalsToDelete);
  const didAdd = await Promise.resolve(ea.addElementsToView(false, false, true));
  if (didAdd === false) {
    return 0;
  }

  selectElements(ea, convertedIds);
  showInlineConversionSkipNotices(skippedNoLatexCount, skippedMissingContainerCount);
  return originalsToDelete.length;
}

function showInlineConversionSkipNotices(
  skippedNoLatexCount: number,
  skippedMissingContainerCount: number
): void {
  if (skippedNoLatexCount > 0) {
    new Notice(
      skippedNoLatexCount === 1
        ? "Selected text contains no inline LaTeX."
        : `${skippedNoLatexCount} selected text elements contain no inline LaTeX.`
    );
  }

  if (skippedMissingContainerCount > 0) {
    new Notice(
      skippedMissingContainerCount === 1
        ? "Skipped one text element because its container was not found."
        : `Skipped ${skippedMissingContainerCount} text elements because their containers were not found.`
    );
  }
}

async function insertInlineTextForElement(
  ea: ExcalidrawAutomateApi,
  textElement: ExcalidrawElement,
  style: InlineTextStyle
): Promise<InlineInsertResult> {
  return insertInlineLinesInArea(
    ea,
    textElement.text ?? "",
    {
      x: toNumber(textElement.x, 0),
      y: toNumber(textElement.y, 0),
      width: Math.max(style.fontSize, toNumber(textElement.width, style.fontSize))
    },
    style
  );
}

async function insertInlineLinesInContainer(
  ea: ExcalidrawAutomateApi,
  textElement: ExcalidrawElement,
  containerElement: ExcalidrawElement,
  style: InlineTextStyle
): Promise<InlineInsertResult> {
  const lines = splitTextLines(textElement.text ?? "");
  const area = getContainerTextArea(textElement, containerElement, style);
  const startY = getContainerContentTopY(area, lines.length, style);
  return insertInlineLinesInArea(
    ea,
    textElement.text ?? "",
    {
      ...area,
      y: startY
    },
    style
  );
}

async function insertInlineLinesInArea(
  ea: ExcalidrawAutomateApi,
  text: string,
  area: { x: number; y: number; width: number },
  style: InlineTextStyle
): Promise<InlineInsertResult> {
  const lines = splitTextLines(text);
  const lineHeight = getLineHeight(style);
  const ids: string[] = [];
  let bounds: InlineBounds | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const fragments = parseInlineLatex(lines[index]);
    if (fragments.length === 0) {
      continue;
    }

    const lineResult = await insertInlineFragments(
      ea,
      fragments,
      {
        x: area.x,
        y: area.y + index * lineHeight,
        centerY: area.y + index * lineHeight + lineHeight / 2,
        align: "left"
      },
      style
    );

    if (lineResult.ids.length === 0 || !lineResult.bounds) {
      continue;
    }

    const lineX = getAlignedLineX(area, lineResult.bounds.width, style.textAlign);
    const dx = lineX - lineResult.bounds.x;
    if (dx !== 0) {
      moveElementsBy(ea, lineResult.ids, dx, 0);
      lineResult.bounds.x += dx;
    }

    ids.push(...lineResult.ids);
    bounds = mergeBounds(bounds, lineResult.bounds);
  }

  return { ids, bounds };
}

async function insertInlineFragments(
  ea: ExcalidrawAutomateApi,
  fragments: InlineLatexFragment[],
  anchor: { x: number; y: number; centerY?: number; align: TextAlign },
  style: InlineTextStyle
): Promise<InlineInsertResult> {
  if (!ea.addText || !ea.addLaTex || !ea.getElement) {
    return { ids: [], bounds: null };
  }

  applyInlineTextStyle(ea, style);

  const latexScale = Math.max(0.6, style.fontSize / 20);
  const ids: string[] = [];

  for (const fragment of fragments) {
    if (fragment.type === "latex") {
      const id = await Promise.resolve(ea.addLaTex(0, 0, fragment.value, latexScale, latexScale));
      if (id) {
        ids.push(id);
      }
      continue;
    }

    const id = ea.addText(0, 0, fragment.value);
    if (id) {
      ids.push(id);
    }
  }

  const elements = ids.map((id) => ea.getElement?.(id)).filter(isExcalidrawElement);
  if (elements.length === 0) {
    return { ids: [], bounds: null };
  }

  const totalWidth = elements.reduce((sum, element) => sum + toNumber(element.width, 0), 0) +
    INLINE_FRAGMENT_GAP * Math.max(0, elements.length - 1);
  const maxHeight = Math.max(...elements.map((element) => toNumber(element.height, style.fontSize)));
  const startX = anchor.align === "center"
    ? anchor.x - totalWidth / 2
    : anchor.align === "right"
      ? anchor.x - totalWidth
      : anchor.x;
  const centerY = anchor.centerY ?? anchor.y + maxHeight / 2;
  const topY = centerY - maxHeight / 2;
  let cursorX = startX;

  for (const element of elements) {
    element.x = cursorX;
    element.y = topY + (maxHeight - toNumber(element.height, style.fontSize)) / 2;
    cursorX += toNumber(element.width, 0) + INLINE_FRAGMENT_GAP;
  }

  return { ids, bounds: getBoundingBoxByIds(ea, ids) };
}

function splitTextLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function getInlineTextStyle(
  ea: ExcalidrawAutomateApi,
  element: ExcalidrawElement | null,
  override?: TextStyleSelection
): InlineTextStyle {
  const appState = safeGetExcalidrawApi(ea)?.getAppState?.() ?? {};
  return {
    strokeColor:
      override?.strokeColor ??
      getStringValue(element?.strokeColor) ??
      getStringValue(appState.currentItemStrokeColor) ??
      getStringValue(ea.style?.strokeColor) ??
      DEFAULT_TEXT_STYLE.strokeColor,
    fontFamily:
      getNumberValue(element?.fontFamily) ??
      getNumberValue(appState.currentItemFontFamily) ??
      getNumberValue(ea.style?.fontFamily) ??
      DEFAULT_FONT_FAMILY,
    fontSize:
      override?.fontSize ??
      getNumberValue(element?.fontSize) ??
      getNumberValue(appState.currentItemFontSize) ??
      getNumberValue(ea.style?.fontSize) ??
      DEFAULT_TEXT_STYLE.fontSize,
    textAlign:
      override?.textAlign ??
      getTextAlign(element?.textAlign) ??
      getTextAlign(appState.currentItemTextAlign) ??
      getTextAlign(ea.style?.textAlign) ??
      DEFAULT_TEXT_STYLE.textAlign,
    verticalAlign:
      getStringValue(element?.verticalAlign) ??
      getStringValue(appState.currentItemVerticalAlign) ??
      "top",
    lineHeight:
      getNumberValue(element?.lineHeight) ??
      getNumberValue(appState.currentItemLineHeight) ??
      DEFAULT_LINE_HEIGHT
  };
}

function applyInlineTextStyle(
  ea: ExcalidrawAutomateApi,
  style: InlineTextStyle
): void {
  if (!ea.style) {
    return;
  }

  ea.style.strokeColor = style.strokeColor;
  ea.style.fontFamily = style.fontFamily;
  ea.style.fontSize = style.fontSize;
  ea.style.textAlign = style.textAlign;
}

function getLineHeight(style: InlineTextStyle): number {
  return style.fontSize * (style.lineHeight > 0 ? style.lineHeight : DEFAULT_LINE_HEIGHT);
}

function getAlignedLineX(
  area: { x: number; width: number },
  lineWidth: number,
  textAlign: TextAlign
): number {
  if (textAlign === "center") {
    return area.x + (area.width - lineWidth) / 2;
  }

  if (textAlign === "right") {
    return area.x + area.width - lineWidth;
  }

  return area.x;
}

function getContainerTextArea(
  textElement: ExcalidrawElement,
  containerElement: ExcalidrawElement,
  style: InlineTextStyle
): InlineBounds {
  const paddingX = Math.max(CONTAINER_PADDING_FALLBACK, style.fontSize * 0.5);
  const paddingY = Math.max(CONTAINER_PADDING_FALLBACK, style.fontSize * 0.35);
  const fallback = {
    x: toNumber(containerElement.x, 0) + paddingX,
    y: toNumber(containerElement.y, 0) + paddingY,
    width: Math.max(style.fontSize, toNumber(containerElement.width, style.fontSize) - 2 * paddingX),
    height: Math.max(style.fontSize, toNumber(containerElement.height, style.fontSize) - 2 * paddingY)
  };

  return {
    x: Number.isFinite(textElement.x) ? toNumber(textElement.x, fallback.x) : fallback.x,
    y: Number.isFinite(textElement.y) ? toNumber(textElement.y, fallback.y) : fallback.y,
    width:
      Number.isFinite(textElement.width) && toNumber(textElement.width, 0) > 0
        ? toNumber(textElement.width, fallback.width)
        : fallback.width,
    height:
      Number.isFinite(textElement.height) && toNumber(textElement.height, 0) > 0
        ? toNumber(textElement.height, fallback.height)
        : fallback.height
  };
}

function getContainerContentTopY(
  area: InlineBounds,
  lineCount: number,
  style: InlineTextStyle
): number {
  const lineHeight = getLineHeight(style);
  const contentHeight = Math.max(lineHeight, lineCount * lineHeight);

  if (style.verticalAlign === "middle" && area.height > contentHeight) {
    return area.y + (area.height - contentHeight) / 2;
  }

  if (style.verticalAlign === "bottom" && area.height > contentHeight) {
    return area.y + area.height - contentHeight;
  }

  return area.y;
}

function getBoundingBoxByIds(
  ea: ExcalidrawAutomateApi,
  ids: string[]
): InlineBounds | null {
  const elements = ids.map((id) => ea.getElement?.(id)).filter(isExcalidrawElement);
  if (elements.length === 0) {
    return null;
  }

  const minX = Math.min(...elements.map((element) => toNumber(element.x, 0)));
  const minY = Math.min(...elements.map((element) => toNumber(element.y, 0)));
  const maxX = Math.max(...elements.map((element) => toNumber(element.x, 0) + toNumber(element.width, 0)));
  const maxY = Math.max(...elements.map((element) => toNumber(element.y, 0) + toNumber(element.height, 0)));

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function mergeBounds(
  first: InlineBounds | null,
  second: InlineBounds | null
): InlineBounds | null {
  if (!first) {
    return second;
  }

  if (!second) {
    return first;
  }

  const minX = Math.min(first.x, second.x);
  const minY = Math.min(first.y, second.y);
  const maxX = Math.max(first.x + first.width, second.x + second.width);
  const maxY = Math.max(first.y + first.height, second.y + second.height);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function moveElementsBy(
  ea: ExcalidrawAutomateApi,
  ids: string[],
  dx: number,
  dy: number
): void {
  for (const id of ids) {
    const element = ea.getElement?.(id);
    if (!element) {
      continue;
    }

    element.x = toNumber(element.x, 0) + dx;
    element.y = toNumber(element.y, 0) + dy;
  }
}

function getViewElementById(
  ea: ExcalidrawAutomateApi,
  id: string
): ExcalidrawElement | null {
  return ea.getViewElements?.().find((element) => element.id === id && !element.isDeleted) ?? null;
}

function getConnectedLinesByElementId(
  ea: ExcalidrawAutomateApi,
  elementIds: string[]
): Map<string, Array<{ line: ExcalidrawElement; side: "start" | "end" }>> {
  const selectedIds = new Set(elementIds);
  const connected = new Map<string, Array<{ line: ExcalidrawElement; side: "start" | "end" }>>();

  for (const element of ea.getViewElements?.() ?? []) {
    if (element.type !== "arrow" && element.type !== "line") {
      continue;
    }

    const startId = element.startBinding?.elementId;
    const endId = element.endBinding?.elementId;

    if (startId && selectedIds.has(startId)) {
      if (!connected.has(startId)) {
        connected.set(startId, []);
      }
      connected.get(startId)?.push({ line: element, side: "start" });
    }

    if (endId && selectedIds.has(endId)) {
      if (!connected.has(endId)) {
        connected.set(endId, []);
      }
      connected.get(endId)?.push({ line: element, side: "end" });
    }
  }

  return connected;
}

function createTransparentAnchor(
  ea: ExcalidrawAutomateApi,
  bounds: InlineBounds,
  connectedLines: Array<{ line: ExcalidrawElement; side: "start" | "end" }>
): string | null {
  if (!ea.addRect || !ea.getElement) {
    return null;
  }

  if (ea.style) {
    ea.style.strokeColor = "transparent";
    ea.style.backgroundColor = "transparent";
    ea.style.fillStyle = "solid";
  }

  const anchorId = ea.addRect(
    bounds.x - INLINE_ANCHOR_PADDING,
    bounds.y - INLINE_ANCHOR_PADDING,
    bounds.width + 2 * INLINE_ANCHOR_PADDING,
    bounds.height + 2 * INLINE_ANCHOR_PADDING
  );
  const anchor = anchorId ? ea.getElement(anchorId) : null;
  if (!anchor) {
    return null;
  }

  anchor.strokeColor = "transparent";
  anchor.backgroundColor = "transparent";
  anchor.fillStyle = "solid";
  anchor.strokeWidth = 1;
  anchor.roughness = 0;
  anchor.opacity = 100;
  anchor.boundElements = connectedLines.map(({ line }) => ({ type: "arrow", id: line.id }));

  return anchorId;
}

function addBoundLinesToElement(
  element: ExcalidrawElement,
  connectedLines: Array<{ line: ExcalidrawElement; side: "start" | "end" }>
): void {
  const boundElements = Array.isArray(element.boundElements)
    ? element.boundElements.filter((boundElement) => boundElement.type !== "text")
    : [];
  const seen = new Set(boundElements.map((boundElement) => `${boundElement.type}:${boundElement.id}`));

  for (const { line } of connectedLines) {
    const key = `arrow:${line.id}`;
    if (!seen.has(key)) {
      boundElements.push({ type: "arrow", id: line.id });
      seen.add(key);
    }
  }

  element.boundElements = boundElements.length > 0 ? boundElements : null;
}

function getSelectedTextElements(ea: ExcalidrawAutomateApi): ExcalidrawElement[] {
  const textElementsById = new Map<string, ExcalidrawElement>();

  const addTextElement = (element: ExcalidrawElement | null | undefined) => {
    if (element?.type === "text" && !element.isDeleted) {
      textElementsById.set(element.id, element);
    }
  };

  try {
    for (const element of ea.getViewSelectedElements?.() ?? []) {
      addTextElement(element);

      for (const boundElement of element.boundElements ?? []) {
        if (boundElement.type === "text") {
          addTextElement(getViewElementById(ea, boundElement.id));
        }
      }
    }
  } catch (error) {
    console.warn("Could not read selected Excalidraw text elements.", error);
  }

  return [...textElementsById.values()];
}

function groupElements(ea: ExcalidrawAutomateApi, ids: string[]): void {
  if (ids.length > 1) {
    ea.addToGroup?.(ids);
  }
}

function selectElements(ea: ExcalidrawAutomateApi, ids: string[]): void {
  if (ids.length > 0) {
    ea.selectElementsInView?.(ids);
  }
}

async function replaceTextElement(
  ea: ExcalidrawAutomateApi,
  view: unknown,
  element: ExcalidrawElement,
  text: string,
  style: TextStyleSelection
): Promise<boolean> {
  if (!setExcalidrawAutomateView(ea, view)) {
    return false;
  }

  const updated = withUpdatedTextAndStyle(element, text, style);

  if (ea.copyViewElementsToEAforEditing && ea.addElementsToView) {
    try {
      ea.copyViewElementsToEAforEditing([updated]);
      return await Promise.resolve(ea.addElementsToView(false));
    } catch (error) {
      console.warn("Could not update text through ExcalidrawAutomate.", error);
    }
  }

  const api = safeGetExcalidrawApi(ea);
  if (!api?.getSceneElements || !api.updateScene) {
    return false;
  }

  try {
    const elements = api.getSceneElements().map((sceneElement) => {
      return sceneElement.id === element.id ? withUpdatedTextAndStyle(sceneElement, text, style) : sceneElement;
    });
    api.updateScene({
      elements,
      commitToHistory: true
    });
    return true;
  } catch (error) {
    console.warn("Could not update text through Excalidraw API.", error);
    return false;
  }
}

async function insertNewTextElement(
  ea: ExcalidrawAutomateApi,
  view: unknown,
  text: string,
  style: TextStyleSelection,
  width: number
): Promise<boolean> {
  if (!ea.addText || !ea.addElementsToView) {
    return false;
  }

  try {
    if (!setExcalidrawAutomateView(ea, view)) {
      return false;
    }

    const api = safeGetExcalidrawApi(ea);
    const appState = api?.getAppState?.() ?? {};
    ea.reset?.();
    applyCurrentTextStyle(ea, appState);
    applySelectedTextStyle(ea, style);

    const point = ea.getViewCenterPosition?.() ?? getViewportCenterScenePoint(view, appState);
    const id = ea.addText(point.x, point.y, text, {
      width,
      textAlign: style.textAlign
    });

    if (!id) {
      return false;
    }

    return await Promise.resolve(ea.addElementsToView(false));
  } catch (error) {
    console.warn("Could not insert text through ExcalidrawAutomate.", error);
    return false;
  }
}

function setExcalidrawAutomateView(ea: ExcalidrawAutomateApi, view: unknown): boolean {
  if (!ea.setView) {
    return true;
  }

  try {
    const target = ea.setView(view, false) ?? ea.setView("active", false) ?? ea.setView("auto", false);
    return Boolean(target);
  } catch (error) {
    console.warn("Could not set ExcalidrawAutomate target view.", error);
    return false;
  }
}

function withUpdatedTextAndStyle(
  element: ExcalidrawElement,
  text: string,
  style: TextStyleSelection
): ExcalidrawElement {
  const next: ExcalidrawElement = {
    ...element,
    text,
    strokeColor: style.strokeColor,
    fontSize: style.fontSize,
    textAlign: style.textAlign
  };

  if ("rawText" in next) {
    next.rawText = text;
  }

  if ("originalText" in next) {
    next.originalText = text;
  }

  return next;
}

function safeGetExcalidrawApi(ea: ExcalidrawAutomateApi): ExcalidrawApi | null {
  try {
    return ea.getExcalidrawAPI?.() ?? null;
  } catch (error) {
    console.warn("Could not access Excalidraw API.", error);
    return null;
  }
}

function applyCurrentTextStyle(
  ea: ExcalidrawAutomateApi,
  appState: Record<string, unknown>
): void {
  if (!ea.style) {
    return;
  }

  copyStyleValue(appState, "currentItemStrokeColor", ea.style, "strokeColor");
  copyStyleValue(appState, "currentItemBackgroundColor", ea.style, "backgroundColor");
  copyStyleValue(appState, "currentItemFontFamily", ea.style, "fontFamily");
  copyStyleValue(appState, "currentItemFontSize", ea.style, "fontSize");
  copyStyleValue(appState, "currentItemTextAlign", ea.style, "textAlign");
  copyStyleValue(appState, "currentItemOpacity", ea.style, "opacity");
  copyStyleValue(appState, "currentItemRoughness", ea.style, "roughness");
}

function applySelectedTextStyle(
  ea: ExcalidrawAutomateApi,
  style: TextStyleSelection
): void {
  if (!ea.style) {
    return;
  }

  ea.style.strokeColor = style.strokeColor;
  ea.style.fontSize = style.fontSize;
  ea.style.textAlign = style.textAlign;
}

function copyStyleValue(
  source: Record<string, unknown>,
  sourceKey: string,
  target: Record<string, unknown>,
  targetKey: string
): void {
  const value = source[sourceKey];
  if (value !== undefined && value !== null) {
    target[targetKey] = value;
  }
}

function getViewportCenterScenePoint(
  view: unknown,
  appState: Record<string, unknown>
): { x: number; y: number } {
  const containerEl = isObject(view) && isHTMLElementLike(view.containerEl)
    ? view.containerEl
    : null;
  const drawingEl = containerEl?.querySelector(".excalidraw") as HTMLElement | null;
  const rect = (drawingEl ?? containerEl)?.getBoundingClientRect();
  const width = rect?.width ?? window.innerWidth;
  const height = rect?.height ?? window.innerHeight;
  const scrollX = toNumber(appState.scrollX, 0);
  const scrollY = toNumber(appState.scrollY, 0);
  const zoom = getZoomValue(appState.zoom);

  return {
    x: Math.round((width / 2 - scrollX) / zoom),
    y: Math.round((height / 2 - scrollY) / zoom)
  };
}

function getZoomValue(value: unknown): number {
  const zoom = isObject(value) ? toNumber(value.value, 1) : toNumber(value, 1);
  return zoom > 0 ? zoom : 1;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isExcalidrawElement(value: unknown): value is ExcalidrawElement {
  return isObject(value) && typeof value.id === "string" && typeof value.type === "string";
}

function isHTMLElementLike(value: unknown): value is HTMLElement {
  return (
    value instanceof HTMLElement ||
    (isObject(value) &&
      typeof value.querySelector === "function" &&
      typeof value.getBoundingClientRect === "function")
  );
}
