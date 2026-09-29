/**
 * Fast local token estimate. Not a tokenizer. Calibrated to sit near Claude's
 * counts on mixed code/log text; use the count_tokens API for exact numbers.
 * Deterministic and dependency-free so the proxy can call it on every result.
 */
const UNIT = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let units = 0;
  let long = 0;
  for (const m of text.matchAll(UNIT)) {
    units++;
    const len = m[0].length;
    if (len > 6) long += Math.floor((len - 1) / 6);
  }
  const byUnits = units + long;
  const byChars = text.length / 3.4;
  // Blend: unit counting tracks prose, char density tracks code and blobs.
  return Math.max(1, Math.round(0.55 * byUnits + 0.45 * byChars));
}
