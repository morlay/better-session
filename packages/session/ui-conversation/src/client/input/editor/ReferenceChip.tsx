/**
 * Visual body of one inline reference chip: the DecoratorNode's React
 * face. Pure display — identity, invalidation, and lifecycle live on the
 * ReferenceChipNode; this component renders whatever the node carries.
 */
import { styling } from "@morlay/dsh-client-ui-primitives/client";
import type { ReactNode } from "react";
import { ReferenceIcon } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ReferenceIconKind } from "@deepseek-ai/dsh-client-ui-primitives";
import { styles } from "./ReferenceChip.styles.ts";
import { styles as referenceCssStyles } from "./composer-editor.styles.ts";

/** Display inputs of one chip (the node's cached owner projections). */
export interface ReferenceChipProps {
  readonly label: string;
  /**
   * Domain glyph; absent renders the trigger marker instead of an icon.
   * `skill` 是本仓库扩展的引用域，官方图标联合没有它，渲染回退到默认字形。
   */
  readonly appearance?: ReferenceIconKind | "skill" | undefined;
  /** Owner-resolution failure styling bit. */
  readonly invalid: boolean;
}

/**
 * Render one inline reference chip.
 * @param props - label, optional domain glyph, and the invalid bit.
 * @returns the chip body (icon + truncating label).
 */
export function ReferenceChip({ label, appearance, invalid }: ReferenceChipProps): ReactNode {
  const glyph: ReferenceIconKind | undefined = appearance === "skill" ? undefined : appearance;
  return (
    <span
      {...styling.props(
        referenceCssStyles.reference,
        styles.chip,
        appearance === "file" && !invalid && referenceCssStyles.openable,
        invalid && styles.invalid,
      )}
      title={label}
    >
      {glyph === undefined ? (
        <span {...styling.props(styles.marker)} aria-hidden>
          @
        </span>
      ) : (
        <ReferenceIcon kind={glyph} size={14} className={styling.className(styles.icon)} />
      )}
      <span {...styling.props(styles.label)}>{label}</span>
    </span>
  );
}
