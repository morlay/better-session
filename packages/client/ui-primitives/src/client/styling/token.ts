import type { CSSProps, CSSValue } from "./css.ts";
import {
  isFunction,
  isNull,
  isPlainObject,
  isString,
  isUndefined,
  mapKeys,
  toMerged,
} from "./toolkit.ts";

const cssVarSymbol = Symbol("cssVar");
const tokensSymbol = Symbol("tokens");
const tokenInstSymbol = Symbol("tokenInst");

export interface CSSVarRef {
  (): Iterable<string>;
  toString(): string;
  [Symbol.toPrimitive](hint: string): string;
}

export type TokenVars<T> = (T extends string | true
  ? CSSVarRef
  : { readonly [K in keyof T]: TokenVars<T[K]> }) &
  CSSVarRef;

export type Tokens = Record<string, unknown>;

const SELF = "$";

function tokenVars<T extends Tokens>(token: Token, tokens: T, path: string[]): TokenVars<T> {
  const reserved = new Set(["constructor", "toJSON", "__proto__"]);

  return new Proxy(() => {}, {
    apply() {
      return Token.fallbackVar(token.cssVar(path));
    },
    get(_target, property) {
      if (
        property === Symbol.toPrimitive ||
        property === Symbol.toStringTag ||
        property === "toString"
      ) {
        return () => `var(${token.cssVar(path)})`;
      }
      if (property === "valueOf") return () => Token.fallbackVar(token.cssVar(path));
      if (property === tokenInstSymbol) return token;
      if (property === tokensSymbol) return tokens;
      if (property === cssVarSymbol) return token.cssVar(path);
      if (!isString(property) || reserved.has(property)) return undefined;
      const next = (tokens as Record<string, unknown>)[property];
      if (isUndefined(next)) return undefined;
      return tokenVars(token, next as Tokens, [...path, property]);
    },
  }) as unknown as TokenVars<T>;
}

export class Token {
  static vars<T extends Tokens>(tokens: T, options: { prefix?: string } = {}): TokenVars<T> {
    return tokenVars<T>(new Token(options.prefix ?? ""), tokens, []);
  }

  static extendsVars<T extends Tokens, E extends Tokens>(
    vars: TokenVars<T>,
    extra: E,
  ): TokenVars<T & E> {
    const tokens = (vars as unknown as Record<symbol, unknown>)[tokensSymbol] ?? {};
    return Token.vars(toMerged(tokens, extra) as T & E);
  }

  static assignVars<T extends Tokens>(
    vars: TokenVars<T>,
    overwrites?: Partial<T>,
  ): Record<`--${string}`, CSSValue> {
    const tokens = (overwrites ??
      (vars as unknown as Record<symbol, unknown>)[tokensSymbol] ??
      {}) as T;
    const token =
      ((vars as unknown as Record<symbol, unknown>)[tokenInstSymbol] as Token | undefined) ??
      new Token("");

    const result: Record<string, CSSValue> = {};
    for (const [name, value] of flattenTokens(token, tokens, []))
      result[name] = token.normalize(value);
    return result as Record<`--${string}`, CSSValue>;
  }

  static variants(variants: Record<string, CSSProps>): Record<string, CSSProps> {
    return mapKeys(variants, (key) => `&[data-variant="${key}"]`) as Record<string, CSSProps>;
  }

  static val<T extends string | number = string>(
    strings: TemplateStringsArray,
    ...values: CSSValue<T>[]
  ): () => Iterable<T> {
    return function* (): Iterable<T> {
      for (let index = 0; index < strings.length; index += 1) {
        const literal = strings[index];
        if (literal) yield literal as T;
        if (index >= values.length) continue;
        const value = values[index];
        yield* isFunction(value) ? value() : [value as T];
      }
    };
  }

  static calc<T extends string | number = string>(
    strings: TemplateStringsArray,
    ...values: CSSValue<T>[]
  ): () => Iterable<T> {
    return combinator("calc(", ")", strings, values);
  }

  static min<T extends string | number = string>(
    strings: TemplateStringsArray,
    ...values: CSSValue<T>[]
  ): () => Iterable<T> {
    return combinator("min(", ")", strings, values);
  }

  static max<T extends string | number = string>(
    strings: TemplateStringsArray,
    ...values: CSSValue<T>[]
  ): () => Iterable<T> {
    return combinator("max(", ")", strings, values);
  }

  static url<T extends string | number = string>(
    strings: TemplateStringsArray,
    ...values: CSSValue<T>[]
  ): () => Iterable<T> {
    return combinator("url(", ")", strings, values);
  }

  static colorMix<T extends string | number = string>(
    strings: TemplateStringsArray,
    ...values: CSSValue<T>[]
  ): () => Iterable<T> {
    return combinator("color-mix(", ")", strings, values);
  }

  static colorScale(
    color: CSSValue<string>,
    options: {
      alpha?: CSSValue<number>;
      lightness?: CSSValue<number>;
      saturation?: CSSValue<number>;
      whiteness?: CSSValue<number>;
      blackness?: CSSValue<number>;
    } = {},
  ): CSSValue<string> {
    const channel = (
      name: string,
      amount: CSSValue<number>,
      max: number,
    ): (() => Iterable<string>) =>
      Token.calc<string>`${name as unknown as string} + (${String(max)} - ${name as unknown as string}) * max(${amount as unknown as CSSValue<string>}, 0) + ${name as unknown as string} * min(${amount as unknown as CSSValue<string>}, 0)`;
    const mix = (
      from: CSSValue<string>,
      to: CSSValue<string>,
      amount: CSSValue<number>,
    ): (() => Iterable<string>) =>
      Token.colorMix<string>`in srgb, ${from}, ${to} ${Token.calc<string>`${amount as unknown as CSSValue<string>} * 100%`}`;

    let result: CSSValue<string> = color;
    if (
      !isUndefined(options.alpha) ||
      !isUndefined(options.lightness) ||
      !isUndefined(options.saturation)
    ) {
      result = Token.val<string>`hsl(from ${result} h ${
        isUndefined(options.saturation)
          ? ("s" as unknown as CSSValue<string>)
          : channel("s", options.saturation, 100)
      } ${isUndefined(options.lightness) ? ("l" as unknown as CSSValue<string>) : channel("l", options.lightness, 100)} / ${
        isUndefined(options.alpha)
          ? ("alpha" as unknown as CSSValue<string>)
          : channel("alpha", options.alpha, 1)
      })`;
    }
    if (!isUndefined(options.whiteness)) result = mix(result, "white", options.whiteness);
    if (!isUndefined(options.blackness)) result = mix(result, "black", options.blackness);
    return result;
  }

  static fallbackVar<T extends string | number = string>(
    value: CSSValue<T>,
    ...fallbacks: CSSValue<T>[]
  ): CSSValue<T> {
    return Object.assign(
      function* (): Iterable<T> {
        yield "var(" as T;
        for (const [index, item] of [value, ...fallbacks].entries()) {
          if (index > 0) yield ", " as T;
          yield* asIterable(item);
        }
        yield ")" as T;
      },
      { [cssVarSymbol]: value },
    );
  }

  static collect<T extends string | number>(value: Iterable<T> | (() => Iterable<T>)): string {
    const iterable = isFunction(value) ? value() : value;
    let result = "";
    for (const item of iterable) result += `${item}`;
    return result;
  }

  constructor(public readonly prefix: string = "") {}

  prop = (key: string): string => (key.startsWith("--") ? key : kebabCase(key));

  normalize = (input: unknown): string => {
    const value = isFunction(input) ? input() : input;
    if (typeof value === "number") return `${value}`;
    if (typeof value === "string") return value;
    if (isUndefined(value) || isNull(value)) return "";

    if (isFunction(value)) return Token.collect(value as () => Iterable<string | number>);
    if (isPlainObject(value) && Symbol.iterator in value)
      return Token.collect(value as Iterable<string | number>);
    return "";
  };

  cssVar = (paths: readonly string[]): string =>
    `--${[this.prefix, ...paths].filter(Boolean).join("-")}`;
}

function combinator<T extends string | number>(
  open: string,
  close: string,
  strings: TemplateStringsArray,
  values: CSSValue<T>[],
): () => Iterable<T> {
  return function* (): Iterable<T> {
    yield open as T;
    yield* Token.val<T>(strings, ...values)();
    yield close as T;
  };
}

function* asIterable<T extends string | number>(value: CSSValue<T>): Iterable<T> {
  const resolved: unknown = isFunction(value) ? (value as () => unknown)() : value;

  const variable = (resolved as Record<symbol, unknown> | undefined)?.[cssVarSymbol];
  if (!isUndefined(variable)) {
    yield variable as T;
    return;
  }
  if (typeof resolved === "object" && resolved !== null && Symbol.iterator in resolved) {
    yield* resolved as Iterable<T>;
    return;
  }
  yield resolved as T;
}

function* flattenTokens(
  token: Token,
  value: Tokens,
  parents: string[],
): Generator<[string, unknown]> {
  for (const [property, child] of Object.entries(value)) {
    if (property === SELF) continue;
    if (isPlainObject(child)) {
      yield* flattenTokens(token, child, [...parents, property]);
      continue;
    }
    yield [token.cssVar([...parents, property]), child];
  }
}

function kebabCase(value: string): string {
  return value.replace(/([A-Z])/g, "-$1").toLowerCase();
}
