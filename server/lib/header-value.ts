/** One request header's value as Express keeps it (a string, or a list for repeated headers), or null. */
export function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}
