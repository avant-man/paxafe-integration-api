/**
 * Rounds half away from zero to `decimals` places (-0.5625 -> -0.563, 0.6875 -> 0.688).
 * Float noise is removed first with toPrecision(15), so 1.005 rounds to 1.01, not 1.00.
 * The shift is done in decimal exponent notation to avoid a binary multiply.
 */
export function roundHalfAwayFromZero(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const sign = value < 0 ? -1 : 1;
  const abs = Number(Math.abs(value).toPrecision(15));
  const text = String(abs);
  if (text.includes('e')) {
    // Below 1e-6 rounds to zero for any precision we use; at 1e21 or more there is no fraction left.
    return abs < 1 ? 0 : value;
  }
  const shifted = Math.round(Number(`${text}e${decimals}`));
  const result = Number(`${shifted}e-${decimals}`);
  return result === 0 ? 0 : sign * result;
}

export function roundOrNull(value: number | null, decimals: number): number | null {
  return value === null ? null : roundHalfAwayFromZero(value, decimals);
}
