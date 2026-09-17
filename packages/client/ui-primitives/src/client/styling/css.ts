import type { StandardProperties, VendorProperties } from "csstype";

type NonStandardProperties = {
  cornerShape?: CSSValue<string>;
  clip?: CSSValue<string>;
  WebkitBoxOrient?: CSSValue<string>;
};

type Properties = Omit<StandardProperties & VendorProperties, keyof NonStandardProperties> &
  NonStandardProperties;

export type CSSVar = `--${string}`;
export type CSSSelector = `&${string}` | `${string}&` | `@${string}`;

export type CSSValue<Fallback = string | number> = Fallback | (() => Iterable<Fallback>);

export type CSSObject<Props extends object, Fallback = string | number> = {
  [K in keyof Props]?: Props[K] | CSSValue<Fallback>;
} & {
  [K in CSSVar]?: CSSValue<Fallback>;
};

type Nested<Props extends object> = CSSObject<Props> & {
  [K in CSSSelector]?: Nested<Props>;
};

export type CSSProps = Nested<Properties>;
