// token 数字的紧凑显示：表格里以总量为主，明细用 K/M/B 压缩。

/** 一位小数；三位数以上不留小数。 */
function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/u, "");
}

/** @param value - token 数（非负整数）。 @returns 紧凑文本，例如 `1.2K`、`44.2B`。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${trim(value / 1_000)}K`;
  if (value < 1_000_000_000) return `${trim(value / 1_000_000)}M`;
  return `${trim(value / 1_000_000_000)}B`;
}
