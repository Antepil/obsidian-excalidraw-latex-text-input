# Excalidraw LaTeX Text Input

An Obsidian companion plugin for writing mixed natural-language and LaTeX-flavored text into Excalidraw as normal text elements.

This plugin is designed for a very specific workflow: you want the fast LaTeX input experience from [LaTeX Suite](https://github.com/artisticat1/obsidian-latex-suite), but you do **not** want Excalidraw to render the formula at insertion time. The final result stays editable as plain Excalidraw text.

## What It Does

- Adds a command: `Insert enhanced text into Excalidraw`
- Opens a CodeMirror-based text input modal while an Excalidraw drawing is active
- Targets the active Excalidraw view before committing text through ExcalidrawAutomate
- Starts with a compact one-line editor that grows as you add lines
- Offers Stroke, Font size, and Text align controls below the editor
- Reuses LaTeX Suite editor extensions when LaTeX Suite is installed and enabled
- Includes a built-in snippet engine based on the LaTeX Suite-style snippet profile in this repository
- Lets LaTeX Suite snippets trigger inside `$...$` and `$$...$$` math regions
- Inserts the final content into Excalidraw as a normal text element
- Updates a selected Excalidraw text element when exactly one text element is selected

It does not call Excalidraw's built-in LaTeX renderer.

## Requirements

- [Obsidian](https://obsidian.md/)
- [Excalidraw for Obsidian](https://github.com/zsviczian/obsidian-excalidraw-plugin)
- [LaTeX Suite](https://github.com/artisticat1/obsidian-latex-suite) for snippet-powered LaTeX input

The plugin still opens a plain text input modal when LaTeX Suite is unavailable, but snippet expansion will not be active.

## BRAT Installation

BRAT installs plugins from GitHub releases. This repository publishes release assets that BRAT can download directly:

- `manifest.json`
- `main.js`
- `styles.css`

The release tag, release title, and `manifest.json` version are kept in sync.

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Open BRAT settings.
3. Choose `Add Beta plugin`.
4. Enter this repository:

   `https://github.com/Antepil/obsidian-excalidraw-latex-text-input`

5. Enable `Excalidraw LaTeX Text Input` in Obsidian community plugin settings.

## Usage

1. Enable Excalidraw, LaTeX Suite, and this plugin.
2. Open an Excalidraw drawing.
3. Run `Excalidraw LaTeX Text Input: Insert enhanced text into Excalidraw` from the command palette.
4. Optionally bind the command in Obsidian `Settings > Hotkeys`.
5. Type text normally. Use `$...$` or `$$...$$` when you want LaTeX Suite snippets to behave like math input.
6. Press `Enter` or click `Insert`.

Use `Shift + Enter` to add a new line in the input box. The editor grows by one line as you add line breaks.

If a single Excalidraw text element is selected, the modal pre-fills its text and updates that element on submit. Otherwise, the command creates a new text element near the current Excalidraw viewport center.

## Snippet Input

The modal has its own LaTeX Suite-style snippet engine, so the core shortcuts work even when LaTeX Suite's editor extension cannot fully attach to this custom input box.

- Text mode shortcuts: type `mk` for inline math or `dm` for display math.
- Math mode shortcuts: type triggers such as `@a`, `sr`, `sq`, `1/`, `//`, `sum`, `lim`, `->`, `RR`, `NN`, `pmat`, and many others from the bundled snippet profile.
- Manual snippets: type triggers like `\sum` or `\int`, then press `Tab` to expand templates with placeholders.
- Snippet-generated text will not recursively trigger another automatic snippet expansion.

Visual-selection snippets from LaTeX Suite are treated as normal insertions in this modal because this command creates plain Excalidraw text rather than editing an Obsidian Markdown selection.

## Settings

- `Default text width`: width used when creating a new Excalidraw text element.
- `Replace selected text`: when enabled, a single selected Excalidraw text element is edited instead of creating a new element.

## Development

```bash
npm install
npm run typecheck
npm run build
```

The plugin entry files required by Obsidian and BRAT are kept at the repository root and attached to each GitHub release:

- `manifest.json`
- `main.js`
- `styles.css`

Release checklist:

1. Update `manifest.json` and `versions.json`.
2. Run `npm run build`.
3. Commit and push.
4. Create a GitHub release whose tag and title exactly match the version in `manifest.json`.
5. Attach `manifest.json`, `main.js`, and `styles.css` as release assets.

## Notes

This plugin intentionally avoids modifying Excalidraw source code. It talks to Excalidraw through the runtime APIs exposed by the Excalidraw Obsidian plugin and uses LaTeX Suite's public `editorExtensions` API for input assistance.

Because this is a companion plugin that integrates two other community plugins, changes in either Excalidraw or LaTeX Suite may require compatibility updates.
