import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DateTimePicker from '../src/components/DateTimePicker.vue';

let wrapper: ReturnType<typeof mount> | undefined;
let trigger: DOMRect;
let width = 340;
let height = 290;
const dialog = () => document.querySelector<HTMLElement>('.datetime-picker-panel')!;

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 800);
  trigger = new DOMRect(100, 100, 400, 36);
  width = 340;
  height = 290;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => trigger);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
    return this.classList.contains('datetime-picker-panel') ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
    return this.classList.contains('datetime-picker-panel') ? height : 0;
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open() {
  wrapper = mount(DateTimePicker, { attachTo: document.body, props: { modelValue: '2026-10-11' } });
  await wrapper.get('.datetime-picker-trigger').trigger('click');
  await nextTick();
}

describe('desktop date picker placement', () => {
  it('opens below when there is enough room and still confirms the date', async () => {
    await open();
    expect(dialog().style.top).toBe('144px');
    expect(dialog().style.left).toBe('100px');
    dialog().querySelector<HTMLButtonElement>('.datetime-picker-confirm')!.click();
    await nextTick();
    expect(wrapper!.emitted('update:modelValue')).toEqual([['2026-10-11']]);
    expect(document.querySelector('.datetime-picker-panel')).toBeNull();
  });

  it('opens above a trigger near the bottom', async () => {
    trigger = new DOMRect(100, 700, 400, 36);
    await open();
    expect(dialog().style.top).toBe('402px');
    expect(parseFloat(dialog().style.top) + height).toBeLessThan(trigger.top);
  });

  it('uses the actual panel width to stay within the right edge', async () => {
    trigger = new DOMRect(1050, 100, 120, 36);
    await open();
    expect(dialog().style.left).toBe('844px');
    width = 460; // Wider non-fine-pointer desktop layout.
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(dialog().style.left).toBe('724px');
  });

  it('clamps a panel when neither side can fit and repositions on ancestor scroll', async () => {
    vi.stubGlobal('innerHeight', 400);
    trigger = new DOMRect(100, 200, 400, 36);
    await open();
    expect(dialog().style.top).toBe('16px');
    trigger = new DOMRect(100, 30, 400, 36);
    wrapper!.element.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(dialog().style.top).toBe('74px');
  });

  it('clears desktop offsets when resizing into the mobile bottom sheet', async () => {
    await open();
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(dialog().style.top).toBe('');
    expect(dialog().style.left).toBe('');
    vi.stubGlobal('innerWidth', 1200);
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(dialog().style.top).toBe('144px');
  });
});
