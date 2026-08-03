import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPiModel,
  getDefaultModelId,
  getModelDisplayName,
  isModelAllowed,
  parseModelAllowlist,
  parseModelEntry,
  resolveModelAllowlist,
  resolveModelAllowlistIds,
} from '../src/agent/pi-model';

describe('parseModelEntry', () => {
  it('parses plain id as key=value with same name', () => {
    expect(parseModelEntry('gpt-4o-mini')).toEqual({
      id: 'gpt-4o-mini',
      name: 'gpt-4o-mini',
    });
  });

  it('parses id=Display Name key=value', () => {
    expect(parseModelEntry('qwen3.6-35b=Qwen 3.6 35B')).toEqual({
      id: 'qwen3.6-35b',
      name: 'Qwen 3.6 35B',
    });
  });

  it('falls back name to id when value empty', () => {
    expect(parseModelEntry('only-id=')).toEqual({
      id: 'only-id',
      name: 'only-id',
    });
  });

  it('returns null for blank', () => {
    expect(parseModelEntry('')).toBeNull();
    expect(parseModelEntry('   ')).toBeNull();
  });
});

describe('parseModelAllowlist', () => {
  it('returns empty for blank input', () => {
    expect(parseModelAllowlist(undefined)).toEqual([]);
    expect(parseModelAllowlist('')).toEqual([]);
    expect(parseModelAllowlist('  ,  , ')).toEqual([]);
  });

  it('trims, splits, and dedupes by id preserving first order', () => {
    expect(parseModelAllowlist(' a,b , a ,c,b')).toEqual([
      { id: 'a', name: 'a' },
      { id: 'b', name: 'b' },
      { id: 'c', name: 'c' },
    ]);
  });

  it('parses mixed plain ids and key=value labels', () => {
    expect(
      parseModelAllowlist(
        'qwen-a=Qwen A, qwen-b, qwen-a=Ignored, qwen-c=Qwen C',
      ),
    ).toEqual([
      { id: 'qwen-a', name: 'Qwen A' },
      { id: 'qwen-b', name: 'qwen-b' },
      { id: 'qwen-c', name: 'Qwen C' },
    ]);
  });
});

describe('getDefaultModelId', () => {
  it('uses OPENAI_MODEL or qwen3.6-35b-a3b-mlx', () => {
    expect(getDefaultModelId({ OPENAI_MODEL: 'my-model' })).toBe('my-model');
    expect(getDefaultModelId({})).toBe('qwen3.6-35b-a3b-mlx');
    expect(getDefaultModelId({ OPENAI_MODEL: '  ' })).toBe(
      'qwen3.6-35b-a3b-mlx',
    );
  });
});

describe('resolveModelAllowlist', () => {
  it('falls back to default when OPENAI_MODELS empty', () => {
    expect(
      resolveModelAllowlist({ OPENAI_MODEL: 'default-m', OPENAI_MODELS: '' }),
    ).toEqual([{ id: 'default-m', name: 'default-m' }]);
  });

  it('prepends default when missing from list', () => {
    expect(
      resolveModelAllowlist({
        OPENAI_MODEL: 'def',
        OPENAI_MODELS: 'a=Alpha,b=Beta',
      }),
    ).toEqual([
      { id: 'def', name: 'def' },
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ]);
  });

  it('keeps order and labels when default already in list', () => {
    expect(
      resolveModelAllowlist({
        OPENAI_MODEL: 'b',
        OPENAI_MODELS: 'a=A,b=B Label,c',
      }),
    ).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B Label' },
      { id: 'c', name: 'c' },
    ]);
  });
});

describe('resolveModelAllowlistIds', () => {
  it('returns ids only', () => {
    expect(
      resolveModelAllowlistIds({
        OPENAI_MODEL: 'def',
        OPENAI_MODELS: 'a=A,b=B',
      }),
    ).toEqual(['def', 'a', 'b']);
  });
});

describe('isModelAllowed', () => {
  const env = { OPENAI_MODEL: 'def', OPENAI_MODELS: 'a=Alpha,b' };

  it('allows default and listed ids', () => {
    expect(isModelAllowed('def', env)).toBe(true);
    expect(isModelAllowed('a', env)).toBe(true);
    expect(isModelAllowed(' unknown ', env)).toBe(false);
    expect(isModelAllowed('', env)).toBe(false);
  });
});

describe('getModelDisplayName', () => {
  it('returns configured label or falls back to id', () => {
    const env = {
      OPENAI_MODEL: 'def',
      OPENAI_MODELS: 'def=Default Label,other=Other',
    };
    expect(getModelDisplayName('def', env)).toBe('Default Label');
    expect(getModelDisplayName('other', env)).toBe('Other');
    expect(getModelDisplayName('unknown', env)).toBe('unknown');
  });
});

describe('buildPiModel', () => {
  afterEach(() => {
    // no process.env mutation in these tests
  });

  it('sets id and display name from allowlist', () => {
    const m = buildPiModel('custom-id', {
      OPENAI_BASE_URL: 'http://localhost:8000/v1/',
      OPENAI_MODEL: 'def',
      OPENAI_MODELS: 'custom-id=Custom Display',
    });
    expect(m.id).toBe('custom-id');
    expect(m.name).toBe('Custom Display');
    expect(m.baseUrl).toBe('http://localhost:8000/v1');
    expect(m.api).toBe('openai-completions');
  });

  it('falls back to default id when omitted', () => {
    const m = buildPiModel(undefined, { OPENAI_MODEL: 'def-only' });
    expect(m.id).toBe('def-only');
    expect(m.name).toBe('def-only');
  });
});
