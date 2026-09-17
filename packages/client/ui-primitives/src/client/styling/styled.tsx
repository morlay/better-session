// 轻量 styled：intrinsic / 组件 + ref，样式走 data-css 属性（不做 polymorphic，
// 参考实现里的 asChild 由 ark-ui 提供，我们不需要）。

import { createElement, forwardRef, useMemo } from "react";
import type {
  ComponentProps,
  ComponentPropsWithRef,
  ElementType,
  ForwardRefExoticComponent,
  Ref,
  RefAttributes,
} from "react";
import type { CSSProps } from "./css.ts";
import { styling } from "./styling.ts";
import { toMerged } from "./toolkit.ts";

type StyledProps<T extends ElementType> = Omit<ComponentProps<T>, "ref">;
type StyledRef<T extends ElementType> =
  ComponentPropsWithRef<T>["ref"] extends Ref<infer R> ? R : never;

const sxSymbol: unique symbol = Symbol("styled.sx");

export type StyledComponent<T extends ElementType> = ForwardRefExoticComponent<
  StyledProps<T> & RefAttributes<StyledRef<T>>
> & { readonly [sxSymbol]: CSSProps };

/**
 * `styled('div')({ padding: '4px' }, { '&:hover': { … } })` → 带 `data-css-*` 的组件。
 * 多个样式对象按顺序深合并（后者覆盖前者），便于把变体叠在基样式上。
 */
export function styled<T extends ElementType>(
  Component: T,
  defaultProps: Partial<ComponentProps<T>> = {},
) {
  return (...styles: CSSProps[]): StyledComponent<T> => {
    const sx = styles.reduce<CSSProps>((merged, style) => toMerged(merged, style), {});

    const Styled = forwardRef<StyledRef<T>, StyledProps<T>>((props, ref) => {
      const styleProps = useMemo(() => styling.props(sx), []);
      return createElement(Component as ElementType, {
        ...defaultProps,
        ...props,
        ...styleProps,
        ref,
      });
    });
    Styled.displayName = `styled(${typeof Component === "string" ? Component : (Component.displayName ?? Component.name ?? "Component")})`;

    return Object.assign(Styled, { [sxSymbol]: sx }) as StyledComponent<T>;
  };
}

/** 取回 styled 组件携带的样式对象（需要在其之上继续组合时用）。 */
export function styleOf(component: StyledComponent<ElementType>): CSSProps {
  return component[sxSymbol];
}
