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

it('keeps rotating clockwise across complete turns in regular and fullscreen viewing and resets on page change', async () => {
  const wrapper = mount(ImageViewer, { props: { pages: [
    { key: 'first', fullUrl: '/synthetic.png', label: '合成页' },
    { key: 'second', fullUrl: '/synthetic-second.png', label: '合成页 2', rotation: 180 }
  ] }, attachTo: document.body });
  try {
    await nextTick();
    const rotate = wrapper.get('.original-viewer-actions button[aria-label="顺时针旋转 90°"]');
    for (const angle of [90, 180, 270, 360, 450, 540, 630, 720]) {
      await rotate.trigger('click');
      expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain(`rotate(${angle}deg)`);
    }
    await wrapper.get('button[title="全屏查看"]').trigger('click');
    for (const angle of [810, 900, 990, 1080]) {
      await wrapper.get('.viewer-orient-button').trigger('click');
      expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain(`rotate(${angle}deg)`);
    }
    await wrapper.get('button[title="下一页"]').trigger('click');
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(180deg)');
    await wrapper.get('button[title="上一页"]').trigger('click');
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(0deg)');
  } finally {
    wrapper.unmount();
  }
});

it('starts the large image at its saved orientation', async () => {
  const wrapper = mount(ImageViewer, { props: { pages: [{ key: 'saved', fullUrl: '/synthetic.png', label: '合成页', rotation: 270 }] }, attachTo: document.body });
  try {
    await nextTick();
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(270deg)');
    await wrapper.get('.original-viewer-actions button[aria-label="顺时针旋转 90°"]').trigger('click');
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(360deg)');
  } finally {
    wrapper.unmount();
  }
});

it.each([0, 90, 180, 270])('renders the requested page at its saved %i degree direction in the first DOM frame', angle => {
  const wrapper = mount(ImageViewer, { props: { startIndex: 1, pages: [
    { key: 'first', fullUrl: '/synthetic-first.png', label: '合成页 1' },
    { key: 'second', fullUrl: '/synthetic-second.png', label: '合成页 2', rotation: angle }
  ] }, attachTo: document.body });
  try {
    expect(wrapper.get('.viewer-image-frame img').attributes('src')).toBe('/synthetic-second.png');
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain(`rotate(${angle}deg)`);
    expect(wrapper.get('.original-viewer-header strong').text()).toBe('合成页 2');
  } finally { wrapper.unmount(); }
});

it('switches an oriented preview to the full image with an immediately fitted new frame while retaining manual rotation', async () => {
  const probes: Array<{ onload: (() => void) | null; naturalWidth: number; naturalHeight: number; src: string }> = [];
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    onerror = null;
    naturalWidth = 400;
    naturalHeight = 600;
    src = '';
    constructor() { probes.push(this); }
  });
  const dimensions = [
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600),
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
  ];
  const wrapper = mount(ImageViewer, { props: { pages: [{
    key: 'saved', fullUrl: '/synthetic-full.png', previewUrl: '/synthetic-preview.jpg',
    label: '合成页', rotation: 270, previewRotation: 270
  }] }, attachTo: document.body });
  try {
    await nextTick();
    const previewImage = wrapper.get('.viewer-image-frame img');
    Object.defineProperties(previewImage.element, { naturalWidth: { value: 600 }, naturalHeight: { value: 400 } });
    await previewImage.trigger('load');
    const frame = wrapper.get('.viewer-image-frame').element;
    await wrapper.get('.original-viewer-actions button[aria-label="顺时针旋转 90°"]').trigger('click');
    expect(wrapper.get('.viewer-image-frame').element).toBe(frame);
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(90deg)');
    probes[0]!.onload!();
    await nextTick();
    expect(wrapper.get('.viewer-image-frame').element).not.toBe(frame);
    expect(wrapper.get('.viewer-image-frame img').attributes('src')).toBe('/synthetic-full.png');
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(360deg)');
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('width: 533px');
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('height: 800px');
    await previewImage.trigger('error');
    await previewImage.trigger('load');
    expect(wrapper.find('.viewer-load-failed').exists()).toBe(false);
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('width: 533px');
  } finally { wrapper.unmount(); dimensions.forEach(mock => mock.mockRestore()); }
});

it('replaces the frame on page changes even when pages share an image URL', async () => {
  const wrapper = mount(ImageViewer, { props: { pages: [
    { key: 'first', fullUrl: '/synthetic.png', label: '合成页 1', rotation: 90 },
    { key: 'second', fullUrl: '/synthetic.png', label: '合成页 2', rotation: 270 }
  ] }, attachTo: document.body });
  try {
    await nextTick();
    const frame = wrapper.get('.viewer-image-frame').element;
    await wrapper.get('button[title="下一页"]').trigger('click');
    expect(wrapper.get('.viewer-image-frame').element).not.toBe(frame);
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(270deg)');
  } finally { wrapper.unmount(); }
});

it('rotates an already oriented thumbnail clockwise through complete turns', async () => {
  const wrapper = mount(ImageViewer, { props: { pages: [{ key: 'saved', fullUrl: '/synthetic.png', previewUrl: '/synthetic-thumb.jpg', label: '合成页', rotation: 270, previewRotation: 270 }] }, attachTo: document.body });
  try {
    await nextTick();
    expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain('rotate(0deg)');
    for (const angle of [90, 180, 270, 360, 450]) {
      await wrapper.get('.original-viewer-actions button[aria-label="顺时针旋转 90°"]').trigger('click');
      expect(wrapper.get('.viewer-image-frame').attributes('style')).toContain(`rotate(${angle}deg)`);
    }
  } finally {
    wrapper.unmount();
  }
});
