/**
 * LLM calls to a client-supplied base URL run on the pinned provider transport.
 *
 * These tests drive the real `resolveModel`, the real AI SDK model from
 * `getModel`, the real SSRF guard and the real pinned transport against
 * loopback HTTP servers speaking the OpenAI chat-completions protocol. Stubbed:
 *
 *  - `@/lib/server/provider-config`, so each test chooses whether the provider
 *    is server-managed and what the server resolves;
 *  - `node:dns`, so a hostname can answer the URL-layer guard and the
 *    connect-time lookup differently (DNS rebinding); and
 *  - the global `fetch`, a spy that must not be called on the client path.
 */
import type { ServerResponse } from 'node:http';

import { generateText, streamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveModel } from '@/lib/server/resolve-model';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import {
  answerWith,
  closeLoopbackServers,
  LOOPBACK_ANSWER,
  PUBLIC_ANSWER,
  startLoopback,
} from '@/tests/helpers/loopback-servers';

const mocks = vi.hoisted(() => ({
  serverManaged: false,
  managedBaseUrl: undefined as string | undefined,
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => mocks.serverManaged,
  resolveApiKey: (_id: string, clientKey: string) => clientKey || 'server-key',
  resolveBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl ?? mocks.managedBaseUrl,
  resolveProxy: () => undefined,
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => mocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

const CHUNKS = ['Hel', 'lo', ', ', 'pinned', ' world', '!', ' More', ' text', ' here', '.'];
const CHUNK_DELAY_MS = 120;

function sseChunk(content: string | null, finish: string | null = null): string {
  const delta = content === null ? {} : { content };
  return `data: ${JSON.stringify({
    id: 'cmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** An OpenAI-compatible server that streams CHUNKS with a delay between each. */
async function startStreamingServer() {
  const state = { written: 0, finished: false };
  const server = await startLoopback((_req, res: ServerResponse, body) => {
    const request = JSON.parse(body.toString('utf8')) as { stream?: boolean };
    if (!request.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
          ],
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    let i = 0;
    const tick = () => {
      if (i < CHUNKS.length) {
        res.write(sseChunk(CHUNKS[i]!));
        state.written = ++i;
        setTimeout(tick, CHUNK_DELAY_MS);
        return;
      }
      res.write(sseChunk(null, 'stop'));
      res.end('data: [DONE]\n\n');
      state.finished = true;
    };
    tick();
  });
  return { ...server, state };
}

async function resolveClientModel(baseUrl: string) {
  const { model } = await resolveModel({
    modelString: 'custom-gateway:test-model',
    providerType: 'openai',
    apiKey: 'client-key',
    baseUrl,
  });
  return model;
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('resolveModel with a client-supplied base URL', () => {
  beforeEach(() => {
    mocks.serverManaged = false;
    mocks.managedBaseUrl = undefined;
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    delete process.env.MODEL_ROUTES;
    globalFetch.mockReset();
    globalFetch.mockRejectedValue(new Error('global fetch must not be used'));
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    await closeLoopbackServers();
  });

  it('streams a long SSE response incrementally through the pinned transport', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const server = await startStreamingServer();
    const model = await resolveClientModel(`${server.origin}/v1`);

    const result = streamText({ model, prompt: 'hi' });
    const seenAt: number[] = [];
    let text = '';
    for await (const delta of result.textStream) {
      // Record how many chunks the server had written when each delta arrived.
      seenAt.push(server.state.written);
      text += delta;
    }

    expect(text).toBe(CHUNKS.join(''));
    // The first delta arrived long before the server finished writing: the
    // pinned path streams rather than buffering the whole response.
    expect(seenAt[0]).toBeLessThan(CHUNKS.length / 2);
    expect(server.state.finished).toBe(true);
    expect(server.lastUrl()).toBe('/v1/chat/completions');
    expect(server.lastHeaders()!.authorization).toBe('Bearer client-key');
    expect(globalFetch).not.toHaveBeenCalled();
  }, 20_000);

  it('refuses a host that rebinds to loopback between validation and connect', async () => {
    const trap = await startStreamingServer();
    const model = await resolveClientModel(`http://rebind.test:${trap.port}/v1`);

    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toBeDefined();

    expect(mocks.callbackLookup).toHaveBeenCalledWith(
      'rebind.test',
      expect.anything(),
      expect.any(Function),
    );
    expect(trap.requests()).toBe(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('refuses a redirect and never follows it', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const target = await startStreamingServer();
    const origin = await startLoopback((_req, res) => {
      res.writeHead(307, { Location: `${target.origin}/v1/chat/completions` });
      res.end();
    });
    const model = await resolveClientModel(`${origin.origin}/v1`);

    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toBeDefined();

    expect(origin.requests()).toBe(1);
    expect(target.requests()).toBe(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('keeps a server-managed endpoint on the operator transport', async () => {
    // Operator-configured endpoints are trusted and not pinned: a managed
    // loopback endpoint keeps working without ALLOW_LOCAL_NETWORKS.
    vi.unstubAllGlobals();
    const managed = await startStreamingServer();
    mocks.serverManaged = true;
    mocks.managedBaseUrl = `${managed.origin}/v1`;

    const model = await resolveClientModel('http://client-choice.test/v1');
    const result = await generateText({ model, prompt: 'hi', maxRetries: 0 });

    expect(result.text).toBe('OK');
    expect(managed.requests()).toBe(1);
  }, 20_000);
});
