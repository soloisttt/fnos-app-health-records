import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import OcrTextOverlay from '../src/components/OcrTextOverlay.vue';

let resize: () => void;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, right: left + width, bottom: top + height, width, height } as DOMRect);
const lines = [
  { id: 'upper', text: '合成项目甲', box: [10, 10, 90, 30], confidence: 1 },
  { id: 'lower', text: '合成项目乙', box: [10, 900, 90, 920], confidence: 1 },
];
async function setup(initialIds = ['lower'], enabled = true) {
  const container = document.createElement('div');
  Object.defineProperties(container, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  const image = document.createElement('img');
  let boxes = [rect(150, 900, 200, 30)];
  let anchorTop = 0, anchorLeft = 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this === container) return rect(100, 100, 400, 300);
    const index = Array.from(this.parentElement?.children || []).filter(el => el.classList.contains('ocr-highlight-group')).indexOf(this);
    const box = boxes[Math.max(0, index)];
    return rect(box.left - container.scrollLeft + anchorLeft, box.top - container.scrollTop + anchorTop, box.width, box.height);
  });
  const wrapper = mount(OcrTextOverlay, { props: {
    image, lines, coordWidth: 1000, coordHeight: 2000, highlightLineIds: initialIds,
    scrollContainer: enabled ? container : undefined, interactive: false,
  } });
  await nextTick(); await nextTick();
  return { wrapper, container, setBoxes: (next: DOMRect[]) => { boxes = next; anchorTop = container.scrollTop; anchorLeft = container.scrollLeft; } };
}

it('reveals a lower row on mount and an upper row on selection without scrolling ancestors', async () => {
  const { wrapper, container, setBoxes } = await setup();
  try {
    expect(container.scrollTop).toBe(665);
    expect(container.scrollLeft).toBe(0);
    setBoxes([rect(150, -300, 200, 30)]);
    await wrapper.setProps({ highlightLineIds: ['upper'] });
    await nextTick();
    expect(container.scrollTop).toBe(130);
    expect(document.documentElement.scrollTop).toBe(0);
  } finally { wrapper.unmount(); }
});

it('keeps fully visible evidence stationary and locates delayed OCR after image resize', async () => {
  const { wrapper, container, setBoxes } = await setup([]);
  try {
    expect(container.scrollTop).toBe(0);
    setBoxes([rect(150, 150, 200, 30)]);
    await wrapper.setProps({ highlightLineIds: ['upper'] }); await nextTick();
    expect(container.scrollTop).toBe(0);
    setBoxes([rect(550, 600, 200, 30)]); // 已变换后的图片坐标。
    resize(); await nextTick(); await nextTick();
    expect(container.scrollLeft).toBe(350);
    expect(container.scrollTop).toBe(365);
  } finally { wrapper.unmount(); }
});

it('shows the first evidence when separated boxes exceed the viewport', async () => {
  const { wrapper, container, setBoxes } = await setup([]);
  try {
    setBoxes([rect(150, 600, 200, 30), rect(150, 1500, 200, 30)]);
    await wrapper.setProps({ highlightLineIds: ['upper', 'lower'] }); await nextTick();
    expect(container.scrollTop).toBe(365);
  } finally { wrapper.unmount(); }
});

it('leaves other overlay consumers and missing evidence unchanged', async () => {
  const { wrapper, container } = await setup(['lower'], false);
  try {
    expect(container.scrollTop).toBe(0);
    await wrapper.setProps({ scrollContainer: container, highlightLineIds: ['missing'] }); await nextTick();
    expect(container.scrollTop).toBe(0);
  } finally { wrapper.unmount(); }
});
