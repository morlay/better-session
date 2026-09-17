export function isUndefined(value: unknown): value is undefined {
  return value === undefined;
}

export function isNull(value: unknown): value is null {
  return value === null;
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toMerged<T>(target: T, source: unknown): T {
  if (!isPlainObject(target) || !isPlainObject(source)) return source as T;
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    result[key] = key in result ? toMerged(result[key], value) : value;
  }
  return result as T;
}

export function mapKeys<T, K extends string>(
  source: Record<string, T>,
  map: (key: string, value: T) => K,
): Record<K, T> {
  const result = {} as Record<K, T>;
  for (const [key, value] of Object.entries(source)) result[map(key, value)] = value;
  return result;
}
