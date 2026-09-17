import type { CSSProps } from "./css.ts";
import { Token } from "./token.ts";
import { isNull, isPlainObject, isUndefined, toMerged } from "./toolkit.ts";

enum RuleType {
  global,
  keyframes,
  scoped,
  scopedClass,
}

interface Sheet {
  id: string;
  contents: string[];
  selector: string | undefined;
}

export class Styling {
  static create(): Styling {
    return new Styling();
  }

  static toRule(sheet: Sheet): string {
    return sheet.selector === undefined
      ? sheet.contents.join("")
      : `${sheet.selector} {${sheet.contents.join("")} }`;
  }

  #token = new Token();
  #sheets = new Map<string, Sheet>();
  #injected = new Set<string>();

  props = (...styles: (CSSProps | false | null | undefined)[]): Record<string, string> => {
    const merged = mergeStyles(styles);
    if (Object.keys(merged).length === 0) return {};
    const sheet = this.#sheet(RuleType.scoped, this.#rules(merged));
    return sheet === undefined ? {} : { [`data-css-${sheet.id}`]: "" };
  };

  keyframes = (frames: Record<string, CSSProps> = {}): string => {
    const sheet = this.#sheet(RuleType.keyframes, this.#rules(frames as unknown as CSSProps));
    return sheet?.id ?? "anim-none";
  };

  injectGlobals = (styles: Record<string, CSSProps> = {}): void => {
    for (const [name, style] of Object.entries(styles)) {
      this.#sheet(RuleType.global, this.#rules(style), name);
    }
  };

  className = (...styles: (CSSProps | false | null | undefined)[]): string => {
    const merged = mergeStyles(styles);
    if (Object.keys(merged).length === 0) return "";
    const sheet = this.#sheet(RuleType.scopedClass, this.#rules(merged));
    return sheet === undefined ? "" : `cls-${sheet.id}`;
  };

  sheets = (): string[] => [...this.#sheets.values()].map((sheet) => Styling.toRule(sheet));

  #sheet(type: RuleType, rules: Generator<string>, selector?: string): Sheet | undefined {
    let hash = 0;
    const contents: string[] = [];
    for (const rule of rules) {
      contents.push(rule);
      hash = incrementalHash(rule, hash);
    }
    if (selector !== undefined) hash = incrementalHash(selector, hash);
    if (hash === 0) return undefined;

    let id = selector ?? "";
    if (type === RuleType.scoped) id = `s${hash.toString(36)}`;
    if (type === RuleType.scopedClass) id = `c${hash.toString(36)}`;
    if (type === RuleType.global) id = `g${hash.toString(36)}`;
    if (type === RuleType.keyframes) id = `a${hash.toString(36)}`;

    let resolvedSelector = selector;
    if (resolvedSelector === undefined) {
      if (type === RuleType.keyframes) resolvedSelector = `@keyframes ${id}`;
      if (type === RuleType.scoped) resolvedSelector = `[data-css-${id}]`;
      if (type === RuleType.scopedClass) resolvedSelector = `.cls-${id}`;
    }

    const sheet: Sheet = { id, contents, selector: resolvedSelector };
    const existing = this.#sheets.get(id);
    if (existing !== undefined && existing.contents.join("") === contents.join("")) return existing;
    this.#sheets.set(id, sheet);
    this.#inject(sheet);
    return sheet;
  }

  #inject(sheet: Sheet): void {
    if (this.#injected.has(sheet.id)) return;
    this.#injected.add(sheet.id);
    if (typeof document === "undefined") return;
    const element = document.createElement("style");
    element.setAttribute("data-css", sheet.id);
    element.textContent = Styling.toRule(sheet);
    document.head.appendChild(element);
  }

  *#rules(styles: CSSProps): Generator<string> {
    const nested = new Map<string, CSSProps>();

    for (const [key, value] of Object.entries(styles)) {
      if (isNull(value) || isUndefined(value)) continue;
      if (isPlainObject(value)) {
        nested.set(key, value as unknown as CSSProps);
        continue;
      }
      yield ` ${this.#token.prop(key)}: ${this.#token.normalize(value)};`;
    }

    for (const [key, value] of nested.entries()) {
      yield ` ${key} {`;
      yield* this.#rules(value);
      yield " }";
    }
  }
}

function mergeStyles(styles: readonly (CSSProps | false | null | undefined)[]): CSSProps {
  return styles.reduce<CSSProps>(
    (accumulated, style) => (style ? (toMerged(accumulated, style) as CSSProps) : accumulated),
    {},
  );
}

function incrementalHash(value: string, previous = 0): number {
  let hash = previous;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash &= 0x7fffffff;
  }
  return hash;
}

export const styling = Styling.create();
