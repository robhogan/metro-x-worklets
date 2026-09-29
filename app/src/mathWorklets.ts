/**
 * Helpers captured into worklet closures. This file is not itself a worklet
 * file: the functions are marked individually.
 */

export function clamp(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

export const SPRING = { damping: 12, stiffness: 120 };
