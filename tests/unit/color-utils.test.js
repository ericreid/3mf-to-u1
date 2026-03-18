import { describe, it, expect } from 'vitest';

const { normalizeColor, toRGBA } = globalThis.MWU1;

describe('normalizeColor', () => {
  it('returns #000000 for null/empty/undefined', () => {
    expect(normalizeColor(null)).toBe('#000000');
    expect(normalizeColor('')).toBe('#000000');
    expect(normalizeColor(undefined)).toBe('#000000');
  });

  it('strips alpha channel from 8-char hex', () => {
    expect(normalizeColor('#FF0000FF')).toBe('#FF0000');
    expect(normalizeColor('#aabbcc80')).toBe('#AABBCC');
  });

  it('converts lowercase to uppercase', () => {
    expect(normalizeColor('#ff8040')).toBe('#FF8040');
    expect(normalizeColor('#abcdef')).toBe('#ABCDEF');
  });

  it('passes through valid 6-char uppercase hex', () => {
    expect(normalizeColor('#FF0000')).toBe('#FF0000');
    expect(normalizeColor('#FFFFFF')).toBe('#FFFFFF');
  });

  it('handles input without # prefix', () => {
    expect(normalizeColor('FF0000')).toBe('#FF0000');
    expect(normalizeColor('aabbccdd')).toBe('#AABBCC');
  });

  it('returns #000000 for invalid hex', () => {
    expect(normalizeColor('#GGHHII')).toBe('#000000');
    expect(normalizeColor('#12345')).toBe('#000000');
    expect(normalizeColor('hello')).toBe('#000000');
  });
});

describe('toRGBA', () => {
  it('appends FF to 7-char hex (#RRGGBB)', () => {
    expect(toRGBA('#FF0000')).toBe('#FF0000FF');
    expect(toRGBA('#aabbcc')).toBe('#AABBCCFF');
  });

  it('passes through 8-char hex unchanged (uppercased)', () => {
    expect(toRGBA('#FF000080')).toBe('#FF000080');
  });

  it('handles input without # prefix', () => {
    expect(toRGBA('FF0000')).toBe('#FF0000FF');
  });
});
