import { describe, expect, it } from 'vitest';
import {
  extractDisplayNameFromMessage,
  resolveDisplayNameForUpdate,
} from '../src/memory/profile-from-message';

describe('extractDisplayNameFromMessage', () => {
  it('extracts "should be X" exactly', () => {
    expect(extractDisplayNameFromMessage('should be alexhong')).toBe(
      'alexhong',
    );
  });

  it('extracts my name is', () => {
    expect(extractDisplayNameFromMessage('my name is Alex Hong')).toBe(
      'Alex Hong',
    );
  });

  it('extracts 叫我', () => {
    expect(extractDisplayNameFromMessage('以後叫我阿明')).toBe('阿明');
  });

  it('returns null when no pattern', () => {
    expect(extractDisplayNameFromMessage('幫我記得明天還書')).toBeNull();
  });
});

describe('resolveDisplayNameForUpdate', () => {
  it('prefers exact user spelling over model typo', () => {
    expect(
      resolveDisplayNameForUpdate('should be alexhong', 'alekhong'),
    ).toBe('alexhong');
  });

  it('falls back to model value when message has no name pattern', () => {
    expect(
      resolveDisplayNameForUpdate('update my profile please', 'Bob'),
    ).toBe('Bob');
  });
});
