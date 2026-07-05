declare module "@codemirror/language" {
  import { Extension, Facet } from "@codemirror/state";
  import { Parser } from "@lezer/common";

  export class Language {
    constructor(
      data: Facet<Record<string, unknown>, readonly Record<string, unknown>[]>,
      parser: Parser,
      extraExtensions?: Extension[],
      name?: string
    );
    extension: Extension;
  }

  export function defineLanguageFacet(
    baseData?: Record<string, unknown>
  ): Facet<Record<string, unknown>, readonly Record<string, unknown>[]>;
}

declare module "@lezer/common" {
  export interface Input {
    length: number;
    lineChunks: boolean;
    chunk(from: number): string;
    read(from: number, to: number): string;
  }

  export interface PartialParse {
    parsedPos: number;
    stoppedAt: number | null;
    stopAt(pos: number): void;
    advance(): Tree | null;
  }

  export class Parser {
    createParse(
      input: Input,
      fragments: readonly TreeFragment[],
      ranges: readonly { from: number; to: number }[]
    ): PartialParse;
    startParse(
      input: Input | string,
      fragments?: readonly TreeFragment[],
      ranges?: readonly { from: number; to: number }[]
    ): PartialParse;
    parse(
      input: Input | string,
      fragments?: readonly TreeFragment[],
      ranges?: readonly { from: number; to: number }[]
    ): Tree;
  }

  export class Tree {
    static build(data: {
      buffer: readonly number[];
      nodeSet: NodeSet;
      topID: number;
      length?: number;
    }): Tree;
  }

  export class TreeFragment {}

  export class NodeType {
    static define(spec: {
      id: number;
      name?: string;
      top?: boolean;
      error?: boolean;
      skipped?: boolean;
    }): NodeType;
  }

  export class NodeSet {
    constructor(types: readonly NodeType[]);
  }
}
