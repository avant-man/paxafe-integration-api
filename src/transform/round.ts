// toPrecision(15) drops float noise, so 1.005 rounds to 1.01.
export function roundHalfAwayFromZero(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const sign = value < 0 ? -1 : 1;
  const abs = Number(Math.abs(value).toPrecision(15));
  const text = String(abs);
  if (text.includes('e')) {
    // Exponent form: below 1e-6 rounds to zero, 1e21 and up has no fraction.
    return abs < 1 ? 0 : value;
  }
  const shifted = Math.round(Number(`${text}e${decimals}`));
  const result = Number(`${shifted}e-${decimals}`);
  return result === 0 ? 0 : sign * result;
}

export function roundOrNull(value: number | null, decimals: number): number | null {
  return value === null ? null : roundHalfAwayFromZero(value, decimals);
}
