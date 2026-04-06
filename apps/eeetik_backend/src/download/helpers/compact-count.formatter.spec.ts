import { formatCompactCount } from './compact-count.formatter';

describe('formatCompactCount', () => {
  it('formats compact values with expected suffixes', () => {
    expect(formatCompactCount(297300)).toBe('297.3K');
    expect(formatCompactCount(26100)).toBe('26.1K');
    expect(formatCompactCount(1700)).toBe('1.7K');
    expect(formatCompactCount(93)).toBe('93');
  });

  it('returns 0 for invalid values', () => {
    expect(formatCompactCount(undefined)).toBe('0');
    expect(formatCompactCount(Number.NaN)).toBe('0');
    expect(formatCompactCount(-1)).toBe('0');
  });
});
