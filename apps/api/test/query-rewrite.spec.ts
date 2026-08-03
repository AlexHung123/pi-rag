import { describe, expect, it } from 'vitest';
import {
  hasDeicticReference,
  isNonRetrievalFollowUp,
  isSelfContainedSummarizeRequest,
  shouldAttemptQueryRewrite,
  stripNonRetrievalNoise,
} from '../src/rag/query-rewrite';

describe('hasDeicticReference', () => {
  it('detects English pronouns', () => {
    expect(hasDeicticReference('what does it mean')).toBe(true);
    expect(hasDeicticReference('explain that error')).toBe(true);
  });

  it('detects Chinese deixis without relying on word boundaries', () => {
    expect(hasDeicticReference('上面那个怎么配置')).toBe(true);
    expect(hasDeicticReference('這個API怎么鉴权')).toBe(true);
    expect(hasDeicticReference('它的限制是什么')).toBe(true);
    expect(hasDeicticReference('那份会议的结论呢')).toBe(true);
  });

  it('is false for self-contained topical questions', () => {
    expect(hasDeicticReference('RAGFlow top_k 参数含义')).toBe(false);
    expect(hasDeicticReference('總結一下會議記錄')).toBe(false);
    // bare 其/其实 should not trigger
    expect(hasDeicticReference('其实 RAGFlow 很好用')).toBe(false);
  });
});

describe('isNonRetrievalFollowUp', () => {
  it('detects length-only requests', () => {
    expect(isNonRetrievalFollowUp('需要5000字左右')).toBe(true);
    expect(isNonRetrievalFollowUp('写详细一点')).toBe(true);
    expect(isNonRetrievalFollowUp('再长一点')).toBe(true);
    expect(isNonRetrievalFollowUp('大约 3000 字')).toBe(true);
  });

  it('detects answer quality complaints', () => {
    expect(isNonRetrievalFollowUp('這總結沒有5000字啊')).toBe(true);
    expect(isNonRetrievalFollowUp('太短了')).toBe(true);
    expect(isNonRetrievalFollowUp('不够详细')).toBe(true);
    expect(isNonRetrievalFollowUp('你写错了')).toBe(true);
  });

  it('does not treat factual questions with a length clause as non-retrieval', () => {
    expect(isNonRetrievalFollowUp('请用5000字总结创新与科技领导系列讲座的要点')).toBe(
      false,
    );
  });
});

describe('isSelfContainedSummarizeRequest', () => {
  it('matches summarize + concrete topic', () => {
    expect(isSelfContainedSummarizeRequest('總結一下會議記錄')).toBe(true);
    expect(isSelfContainedSummarizeRequest('summarize the Q3 roadmap doc')).toBe(
      true,
    );
  });

  it('rejects bare summarize without topic', () => {
    expect(isSelfContainedSummarizeRequest('总结一下')).toBe(false);
    expect(isSelfContainedSummarizeRequest('summarize it')).toBe(false);
  });
});

describe('shouldAttemptQueryRewrite', () => {
  const history = [
    { role: 'user' as const, content: '介绍一下 RAGFlow' },
    { role: 'assistant' as const, content: 'RAGFlow 是…' },
  ];

  it('skips length-only and complaint turns even with history', () => {
    expect(shouldAttemptQueryRewrite('需要5000字左右', history)).toBe(false);
    expect(shouldAttemptQueryRewrite('這總結沒有5000字啊', history)).toBe(false);
  });

  it('skips self-contained summarize first turns', () => {
    expect(shouldAttemptQueryRewrite('總結一下會議記錄', [])).toBe(false);
  });

  it('attempts rewrite for deictic multi-turn follow-ups', () => {
    expect(shouldAttemptQueryRewrite('它的 top_k 是什么意思', history)).toBe(
      true,
    );
    expect(shouldAttemptQueryRewrite('上面那个怎么配置', history)).toBe(true);
  });

  it('attempts rewrite for short ambiguous follow-ups with history', () => {
    expect(shouldAttemptQueryRewrite('结论呢', history)).toBe(true);
    expect(shouldAttemptQueryRewrite('还有呢', history)).toBe(true);
  });

  it('skips long self-contained questions even with history', () => {
    expect(
      shouldAttemptQueryRewrite(
        'RAGFlow hybrid search 里 vector_similarity_weight 默认是多少',
        history,
      ),
    ).toBe(false);
  });

  it('skips long self-contained first-turn questions', () => {
    expect(
      shouldAttemptQueryRewrite(
        'Explain how RAGFlow hybrid retrieval combines vector and keyword scores',
        [],
      ),
    ).toBe(false);
  });
});

describe('stripNonRetrievalNoise', () => {
  it('removes length and format noise from rewrite output', () => {
    expect(
      stripNonRetrievalNoise(
        '2026年7月3日创新与科技领导系列专題讲座会议记录详细全文 5000字',
      ),
    ).toBe('2026年7月3日创新与科技领导系列专題讲座会议记录');
    expect(stripNonRetrievalNoise('roadmap summary 约3000字 用表格')).toContain(
      'roadmap summary',
    );
    expect(stripNonRetrievalNoise('roadmap summary 约3000字 用表格')).not.toMatch(
      /3000|表格/,
    );
  });
});
