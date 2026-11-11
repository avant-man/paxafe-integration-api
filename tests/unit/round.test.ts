import { describe, expect, it } from 'vitest';
import { roundHalfAwayFromZero, roundOrNull } from '../../src/transform/round.js';

describe('roundHalfAwayFromZero', () => {
  it.each([
    [-0.5625, 3, -0.563],
    [0.6875, 3, 0.688],
    [-0.4375, 3, -0.438],
    [0.9901862198596787, 3, 0.99],
    [10.078125, 2, 10.08],
    [38.70000076293945, 1, 38.7],
    [1.005, 2, 1.01],
    [-1.005, 2, -1.01],
    [2.675, 2, 2.68],
    [1.45, 1, 1.5],
    [-1.45, 1, -1.5],
    [0.5, 0, 1],
    [-0.5, 0, -1],
    [-100, 2, -100],
    [0, 3, 0],
  ])('rounds %d to %d places as %d', (value, places, expected) => {
    expect(roundHalfAwayFromZero(value, places)).toBe(expected);
  });

  it('never returns negative zero', () => {
    expect(Object.is(roundHalfAwayFromZero(-0.0001, 3), 0)).toBe(true);
    expect(Object.is(roundHalfAwayFromZero(-0, 2), 0)).toBe(true);
  });

  it('handles tiny values written in exponent notation', () => {
    expect(roundHalfAwayFromZero(1e-7, 3)).toBe(0);
    expect(roundHalfAwayFromZero(-1e-9, 2)).toBe(0);
  });

  it('passes null through', () => {
    expect(roundOrNull(null, 2)).toBeNull();
    expect(roundOrNull(4.125, 2)).toBe(4.13);
  });
});
