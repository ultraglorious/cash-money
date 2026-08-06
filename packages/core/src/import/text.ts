/** Normalized text for matching: NFC + trim + lowercase. Never shown to users. */
export function fold(s: string): string {
  return s.normalize("NFC").trim().toLowerCase();
}

/** Display-normalized text: NFC + trim (preserves original case). */
export function trimN(s: string): string {
  return s.normalize("NFC").trim();
}

/**
 * Unit separator for composite map keys — a byte that cannot appear in field
 * values, so two different tuples can never collide.
 */
export const SEP = "␟";
