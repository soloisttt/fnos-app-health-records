import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ImageViewer from '../src/components/ImageViewer.vue';
import OriginalOrientation from '../src/components/OriginalOrientation.vue';

const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe = observe;
    disconnect = disconnect;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('rotates the inline original through all four directions and resets for another page', async () => {
  const image = document.createElement('img');
  Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 800 } });
  const wrapper = mount(OriginalOrientation, { props: { image, pageKey: 'first' }, attachTo: document.body });
  try {
    const viewport = wrapper.get('.original-orientation-viewport').element;
    Object.defineProperty(viewport, 'clientWidth', { value: 400 });
    image.dispatchEvent(new Event('load'));
    await nextTick();
    const button = wrapper.get('button[aria-label="顺时针旋转 90°"]');
    for (const angle of [90, 180, 270, 0]) {
      await button.trigger('click');
      expect(wrapper.get('.original-orientation-content').attributes('style')).toContain(`rotate(${angle}deg)`);
    }
    await button.trigger('click');
    await wrapper.setProps({ pageKey: 'second', initialRotation: 180 });
    expect(wrapper.get('.original-orientation-content').attributes('style')).toContain('rotate(180deg)');
  } finally {
    wrapper.unmount();
  }
});

it('uses the same four-step rotation in regular and fullscreen image viewing', async () => {
  const wrapper = mount(ImageViewer, { props: { pages: [{ key: 'first', fullUrl: '/synthetic.png', label: '合成页' }] }, attachTo: document.body });
  try {
    await nextTick();
    const rotate = wrapper.get('.original-viewer-actions button[aria-label="顺时针旋转 90°"]');
    for (const angle of [90, 180, 270, 0]) {
      await rotate.trigger('click');
      expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain(`rotate(${angle}deg)`);
    }
    await wrapper.get('button[title="全屏查看"]').trigger('click');
    await wrapper.get('.viewer-orient-button').trigger('click');
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(90deg)');
  } finally {
    wrapper.unmount();
  }
});

it('starts the large image at its saved orientation', async () => {
  const wrapper = mount(ImageViewer, { props: { pages: [{ key: 'saved', fullUrl: '/synthetic.png', label: '合成页', rotation: 270 }] }, attachTo: document.body });
  try {
    await nextTick();
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(270deg)');
  } finally {
    wrapper.unmount();
  }
});

it('does not rotate a thumbnail that already includes the saved orientation', async () => {
  const wrapper = mount(ImageViewer, { props: { pages: [{ key: 'saved', fullUrl: '/synthetic.png', previewUrl: '/synthetic-thumb.jpg', label: '合成页', rotation: 90, previewRotation: 90 }] }, attachTo: document.body });
  try {
    await nextTick();
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(0deg)');
    await wrapper.get('.original-viewer-actions button[aria-label="顺时针旋转 90°"]').trigger('click');
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(90deg)');
  } finally {
    wrapper.unmount();
  }
});
