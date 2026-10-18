// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InteractiveIframeHost } from '@/components/scene-renderers/InteractiveIframeHost';
import { useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import { MEDIA_CONTROL } from '@/lib/interactive/media-bridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
let root: Root;
let container: HTMLDivElement;
const onMediaPlay = vi.fn();
const entry = {
  src: 'https://example.test/activity',
  rect: { left: 0, top: 0, width: 960, height: 540 },
  clip: { left: 0, top: 0, width: 960, height: 540 },
  owner: 'test',
  tick: 1,
};
beforeEach(async () => {
  onMediaPlay.mockReset();
  useInteractiveIframePool.getState().reset();
  useWidgetIframeStore.setState({
    sendMessageByScene: {},
    documentTokenByScene: {},
    readyByScene: {},
    pendingMessagesByScene: {},
    activeSceneId: null,
  });
  useInteractiveIframePool.setState({ entries: { s: entry }, activeSceneId: 's' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(InteractiveIframeHost, { onMediaPlay }));
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useInteractiveIframePool.getState().reset();
});
function open() {
  const button = document.querySelector('button')!;
  expect(button.textContent).toContain('chat.externalInteractive.open');
  act(() => button.click());
}
it('pauses narration before enabling a URL and resolves silence only after its frame unmounts', async () => {
  expect(document.querySelector('iframe')).toBeNull();
  open();
  expect(onMediaPlay).toHaveBeenCalledTimes(1);
  expect(document.querySelector('iframe')?.getAttribute('src')).toBe(entry.src);
  let pause: Promise<boolean> | undefined;
  await act(async () => {
    pause = useWidgetIframeStore
      .getState()
      .sendMessageByScene.s(MEDIA_CONTROL, {}) as Promise<boolean>;
    expect(pause).toBeInstanceOf(Promise);
    expect(useWidgetIframeStore.getState().sendMessageByScene.s(MEDIA_CONTROL, {})).toBe(pause);
  });
  expect(document.querySelector('iframe')).toBeNull();
  await expect(pause).resolves.toBe(true);
  open();
  expect(onMediaPlay).toHaveBeenCalledTimes(2);
});
it('unloads a URL when pooled navigation hides it and requires another explicit open on return', async () => {
  open();
  expect(document.querySelector('iframe')).not.toBeNull();
  await act(async () => {
    useInteractiveIframePool.setState({ activeSceneId: 'other' });
  });
  expect(document.querySelector('iframe')).toBeNull();
  await act(async () => {
    useInteractiveIframePool.setState({ activeSceneId: 's' });
  });
  expect(document.querySelector('iframe')).toBeNull();
  open();
  expect(document.querySelector('iframe')).not.toBeNull();
});
