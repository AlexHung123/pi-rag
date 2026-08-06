import { describe, expect, it } from 'vitest';
import { RagflowMockStore } from '../src/ragflow/ragflow-mock.store';

describe('RagflowMockStore empty document + manual chunks', () => {
  it('creates empty document with zero size and no chunks', () => {
    const store = new RagflowMockStore();
    const ds = store.createDataset({ name: 'kb1' });
    const doc = store.createEmptyDocument(ds.id, 'notes.md');
    expect(doc.id).toBeTruthy();
    expect(doc.name).toBe('notes.md');
    expect(doc.size).toBe(0);
    expect(doc.chunk_count).toBe(0);
    expect(String(doc.run).toUpperCase()).toContain('UNSTART');
  });

  it('adds chunks and marks document done', () => {
    const store = new RagflowMockStore();
    const ds = store.createDataset({ name: 'kb1' });
    const doc = store.createEmptyDocument(ds.id, 'notes.md');
    const chunk = store.addChunk(ds.id, doc.id, {
      content: 'Hello manual chunk',
      importantKeywords: ['hello'],
    });
    expect(chunk.id).toBeTruthy();
    expect(chunk.content).toBe('Hello manual chunk');
    expect(chunk.important_keywords).toEqual(['hello']);

    const listed = store.listChunks(ds.id, doc.id, 1, 10);
    expect(listed.total).toBe(1);
    expect(listed.chunks[0].content).toBe('Hello manual chunk');

    const refreshed = store.getDocument(ds.id, doc.id);
    expect(refreshed?.chunk_count).toBe(1);
    expect(String(refreshed?.run).toUpperCase()).toBe('DONE');
  });

  it('updates chunk content and keywords', () => {
    const store = new RagflowMockStore();
    const ds = store.createDataset({ name: 'kb1' });
    const doc = store.createEmptyDocument(ds.id, 'notes.md');
    const chunk = store.addChunk(ds.id, doc.id, { content: 'v1' });
    store.updateChunk(ds.id, doc.id, chunk.id, {
      content: 'v2',
      importantKeywords: ['tag'],
      available: false,
    });
    const listed = store.listChunks(ds.id, doc.id, 1, 10);
    expect(listed.chunks[0].content).toBe('v2');
    expect(listed.chunks[0].important_keywords).toEqual(['tag']);
    expect(listed.chunks[0].available).toBe(false);
  });

  it('deletes chunks and reverts to unstart when empty', () => {
    const store = new RagflowMockStore();
    const ds = store.createDataset({ name: 'kb1' });
    const doc = store.createEmptyDocument(ds.id, 'notes.md');
    const a = store.addChunk(ds.id, doc.id, { content: 'a' });
    store.addChunk(ds.id, doc.id, { content: 'b' });
    store.deleteChunks(ds.id, doc.id, [a.id]);
    expect(store.listChunks(ds.id, doc.id, 1, 10).total).toBe(1);

    const b = store.listChunks(ds.id, doc.id, 1, 10).chunks[0];
    store.deleteChunks(ds.id, doc.id, [b.id]);
    expect(store.listChunks(ds.id, doc.id, 1, 10).total).toBe(0);
    const refreshed = store.getDocument(ds.id, doc.id);
    expect(String(refreshed?.run).toUpperCase()).toContain('UNSTART');
    expect(refreshed?.chunk_count).toBe(0);
  });

  it('retrieve finds manual chunk content', () => {
    const store = new RagflowMockStore();
    const ds = store.createDataset({ name: 'kb1' });
    const doc = store.createEmptyDocument(ds.id, 'notes.md');
    store.addChunk(ds.id, doc.id, {
      content: 'The capital of France is Paris',
    });
    const hits = store.retrieve([ds.id], 'capital of France', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('Paris');
  });
});
