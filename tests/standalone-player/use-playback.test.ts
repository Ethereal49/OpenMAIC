// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManifestScene } from '@/lib/export/classroom-zip-types';
import { usePlayback, type Playback } from '@/lib/standalone-player/playback/use-playback';
import { NarrationPlayer, WidgetChannel } from '@/lib/standalone-player/playback/media-ports';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const scenes = [0, 1].map((order) => ({
  type: 'interactive',
  order,
  title: String(order),
  content: { type: 'interactive' },
  actions: ['A', 'B'].map((text) => ({ id: text, type: 'speech', text, audioRef: text })),
})) as ManifestScene[];
let root: Root;
let playback: Playback;
let index: number;
let finishAudio: () => void;
const navigate = vi.fn();
function Probe() {
  const current = usePlayback(scenes, index, navigate);
  useEffect(() => {
    playback = current;
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(NarrationPlayer.prototype, 'prime').mockImplementation(() => {});
  vi.spyOn(NarrationPlayer.prototype, 'play').mockImplementation(
    (_ref, control) =>
      new Promise((resolve) => {
        finishAudio = () => resolve(true);
        control.signal.addEventListener('abort', () => resolve(true), { once: true });
      }),
  );
  vi.spyOn(WidgetChannel.prototype, 'pauseMedia')
    .mockReturnValue(true)
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(Promise.resolve(false));
  navigate.mockReset();
  index = 0;
  root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function blockSecondSpeech() {
  await act(async () => playback.play());
  expect(NarrationPlayer.prototype.play).toHaveBeenCalledWith('A', expect.anything());
  await act(async () => finishAudio());
}

describe('standalone narration silence failures', () => {
  it('pauses on the current speech and retries its audio instead of advancing on reading time', async () => {
    await blockSecondSpeech();
    expect(playback.state).toMatchObject({ mode: 'paused', view: { caption: 'B' } });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(playback.state).toMatchObject({ mode: 'paused', view: { caption: 'B' } });
    expect(navigate).not.toHaveBeenCalled();
    expect(NarrationPlayer.prototype.play).toHaveBeenCalledTimes(1);
    await act(async () => playback.play());
    expect(playback.state.mode).toBe('playing');
    expect(NarrationPlayer.prototype.play).toHaveBeenLastCalledWith('B', expect.anything());
    expect(NarrationPlayer.prototype.play).toHaveBeenCalledTimes(2);
  });

  it('cancels the blocked sentence when navigating away', async () => {
    await blockSecondSpeech();
    index = 1;
    await act(async () => root.render(createElement(Probe)));
    expect(playback.state.mode).toBe('idle');
    expect(NarrationPlayer.prototype.play).toHaveBeenCalledTimes(1);
  });

  it('cancels a blocked sentence on disposal', async () => {
    await blockSecondSpeech();
    await act(async () => root.render(null));
    expect(NarrationPlayer.prototype.play).toHaveBeenCalledTimes(1);
  });
});
