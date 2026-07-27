/**
 * Replay / probe the OpenAI-compatible gateway with a payload similar to the agent.
 * Usage (from apps/api):
 *   node scripts/probe-llm.mjs
 *   node scripts/probe-llm.mjs --file data/llm-debug/last-error.json
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const key = m[1];
    let val = m[2].replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

const baseUrl = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const apiKey = process.env.OPENAI_API_KEY || 'not-needed';

const fileArgIdx = process.argv.indexOf('--file');
let body;

if (fileArgIdx >= 0 && process.argv[fileArgIdx + 1]) {
  const dump = JSON.parse(readFileSync(process.argv[fileArgIdx + 1], 'utf8'));
  body = dump.payload;
  if (!body) {
    console.error('Dump has no .payload field:', process.argv[fileArgIdx + 1]);
    process.exit(1);
  }
  console.log('Replaying payload from', process.argv[fileArgIdx + 1]);
  console.log('Original error:', dump.error?.message?.slice(0, 200));
} else {
  body = {
    model,
    messages: [
      { role: 'system', content: 'You are a knowledge-base assistant.' },
      { role: 'user', content: 'Say hi in one short sentence.' },
    ],
    stream: true,
    max_tokens: 64,
    tools: [
      {
        type: 'function',
        function: {
          name: 'list_knowledge_bases',
          description: 'List knowledge bases',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'retrieve_chunks',
          description: 'Retrieve chunks',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              knowledgeBaseIds: { type: 'array', items: { type: 'string' } },
              topK: { type: 'number' },
            },
            required: ['query', 'knowledgeBaseIds'],
          },
        },
      },
    ],
  };
}

const url = `${baseUrl}/chat/completions`;
console.log('POST', url);
console.log('model:', body.model || model);
console.log(
  'messages:',
  Array.isArray(body.messages) ? body.messages.length : 0,
  'tools:',
  Array.isArray(body.tools) ? body.tools.length : 0,
  'stream:',
  body.stream,
);

const started = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(body),
});

const text = await res.text();
const ms = Date.now() - started;
console.log('status:', res.status, res.headers.get('server') || '', `(${ms}ms)`);
console.log('body (first 800 chars):');
console.log(text.slice(0, 800));
process.exit(res.ok ? 0 : 1);
