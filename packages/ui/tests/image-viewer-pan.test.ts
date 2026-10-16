import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ImageViewer from '../src/components/ImageViewer.vue';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

async function openViewer() {
  const wrapper = mount(ImageViewer, { props: { pages: [
    { key: 'first', fullUrl: '/synthetic-first.png', label: '合成页 1' },
    { key: 'second', fullUrl: '/synthetic-second.png', label: '合成页 2' },
  ] }, attachTo: document.body });
  await nextTick();
  const canvas = wrapper.get('.original-viewer-canvas');
  const captured = new Set<number>();
  const capture = vi.fn((id: number) => captured.add(id));
  const release = vi.fn((id: number) => captured.delete(id));
  Object.assign(canvas.element, {
    setPointerCapture: capture, releasePointerCapture: release,
    hasPointerCapture: (id: number) => captured.has(id),
  });
  const mouse = { pointerType: 'mouse', pointerId: 1, button: 0, clientX: 100, clientY: 100 };
  const transform = () => wrapper.get('.viewer-image-frame').attributes('style');
  return { wrapper, canvas, capture, release, mouse, transform };
}

it('pans a zoomed image with mouse capture, then stops on release', async () => {
  const { wrapper, canvas, capture, release, mouse, transform } = await openViewer();
  try {
    await wrapper.get('button[title="放大"]').trigger('click');
    expect(canvas.classes()).toContain('pannable');
    expect(wrapper.get('.viewer-image-frame img').attributes('draggable')).toBe('false');
    await canvas.trigger('pointerdown', mouse);
    expect(capture).toHaveBeenCalledWith(1);
    await canvas.trigger('pointermove', { ...mouse, pointerId: 2, clientX: 900 });
    expect(transform()).toContain('translate3d(0px, 0px, 0)');
    await canvas.trigger('pointermove', { ...mouse, clientX: 180, clientY: 60 });
    expect(transform()).toContain('translate3d(80px, -40px, 0)');
    expect(canvas.classes()).toContain('gesturing');
    await canvas.trigger('pointerup', mouse);
    expect(release).toHaveBeenCalledWith(1);
    expect(canvas.classes()).not.toContain('gesturing');
    await canvas.trigger('pointermove', { ...mouse, clientX: 250 });
    expect(transform()).toContain('translate3d(80px, -40px, 0)');
  } finally { wrapper.unmount(); }
});

it('leaves fit view, right clicks, touch pointers, and canvas buttons out of mouse panning', async () => {
  const { wrapper, canvas, capture, mouse, transform } = await openViewer();
  try {
    await canvas.trigger('pointerdown', mouse);
    await canvas.trigger('pointermove', { ...mouse, clientX: 180 });
    expect(capture).not.toHaveBeenCalled();
    await wrapper.get('button[title="放大"]').trigger('click');
    await canvas.trigger('pointerdown', { ...mouse, button: 2 });
    await canvas.trigger('pointerdown', { ...mouse, pointerType: 'touch' });
    await wrapper.get('button[title="全屏查看"]').trigger('pointerdown', mouse);
    expect(capture).not.toHaveBeenCalled();
    expect(transform()).toContain('translate3d(0px, 0px, 0)');
    // The existing touch handler still owns touch panning.
    await canvas.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
    await canvas.trigger('touchmove', { touches: [{ clientX: 120, clientY: 140 }] });
    expect(transform()).toContain('translate3d(20px, 40px, 0)');
    await canvas.trigger('touchend', { touches: [], changedTouches: [{ clientX: 120, clientY: 140 }] });
  } finally { wrapper.unmount(); }
});

it.each(['pointercancel', 'lostpointercapture'])('ends mouse dragging on %s without leaving fullscreen', async ending => {
  const { wrapper, canvas, mouse, transform } = await openViewer();
  try {
    await wrapper.get('button[title="全屏查看"]').trigger('click');
    await wrapper.get('button[title="放大"]').trigger('click');
    await canvas.trigger('pointerdown', mouse);
    await canvas.trigger('pointermove', { ...mouse, clientX: 150 });
    await canvas.trigger(ending, mouse);
    await canvas.trigger('click');
    expect(wrapper.get('.original-viewer').classes()).toContain('immersive');
    await canvas.trigger('pointermove', { ...mouse, clientX: 300 });
    expect(transform()).toContain('translate3d(50px, 0px, 0)');
    // A subsequent deliberate background click can still exit fullscreen.
    await canvas.trigger('pointerdown', mouse);
    await canvas.trigger('pointerup', mouse);
    await canvas.trigger('click');
    expect(wrapper.get('.original-viewer').classes()).not.toContain('immersive');
  } finally { wrapper.unmount(); }
});

it('keeps captured image clicks in fullscreen and resets dragging on zoom, rotation and page changes', async () => {
  const { wrapper, canvas, release, mouse, transform } = await openViewer();
  try {
    await wrapper.get('button[title="全屏查看"]').trigger('click');
    await wrapper.get('button[title="放大"]').trigger('click');
    await wrapper.get('.viewer-image-frame img').trigger('pointerdown', mouse);
    await canvas.trigger('pointerup', mouse);
    await canvas.trigger('click');
    expect(wrapper.get('.original-viewer').classes()).toContain('immersive');
    for (const action of ['缩小', '顺时针旋转 90°', '下一页']) {
      await canvas.trigger('pointerdown', mouse);
      await canvas.trigger('pointermove', { ...mouse, clientY: 160 });
      await wrapper.get(`button[title="${action}"]`).trigger('click');
      expect(release).toHaveBeenCalledWith(1);
      expect(transform()).toContain('translate3d(0px, 0px, 0)');
      expect(canvas.classes()).not.toContain('gesturing');
      await canvas.trigger('pointermove', { ...mouse, clientX: 300 });
      expect(transform()).toContain('translate3d(0px, 0px, 0)');
      await wrapper.get('button[title="放大"]').trigger('click');
    }
    await wrapper.get('button[title="关闭"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  } finally { wrapper.unmount(); }
});
