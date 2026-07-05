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
  addText?: (
    x: number,
    y: number,
    text: string,
    options?: Record<string, unknown>
  ) => string | null;
  addElementsToView?: (repositionToCursor?: boolean) => Promise<boolean> | boolean;
  copyViewElementsToEAforEditing?: (elements: ExcalidrawElement[]) => void;
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

interface ModalOptions {
  initialText: string;
  initialStyle: TextStyleSelection;
  latexSuiteExtensions: Extension[];
  onSubmit: (text: string, style: TextStyleSelection) => Promise<void>;
}

const DEFAULT_SETTINGS: ExcalidrawLatexTextSettings = {
  defaultTextWidth: 500,
  replaceSelectedText: true
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

function isHTMLElementLike(value: unknown): value is HTMLElement {
  return (
    value instanceof HTMLElement ||
    (isObject(value) &&
      typeof value.querySelector === "function" &&
      typeof value.getBoundingClientRect === "function")
  );
}
