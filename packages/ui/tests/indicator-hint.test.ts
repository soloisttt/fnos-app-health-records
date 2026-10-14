import { afterEach, expect, it } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import IndicatorHint from '../src/components/IndicatorHint.vue';

let wrapper: ReturnType<typeof mount>;
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; });

it('keeps existing hints click-only and closes on a second click', async () => {
  wrapper = mount(IndicatorHint, { props: { text: '合成提示' }, attachTo: document.body });
  await wrapper.get('.indicator-hint-anchor').trigger('mouseenter');
  expect(document.querySelector('.indicator-hint-panel')).toBeNull();
  await wrapper.get('button').trigger('click');
  await flushPromises();
  expect(document.querySelector('.indicator-hint-panel')?.textContent).toContain('合成提示');
  await wrapper.get('button').trigger('click');
  expect(document.querySelector('.indicator-hint-panel')).toBeNull();
});

it('shows hover hints on pointer entry and keyboard focus, then hides on leave or blur', async () => {
  wrapper = mount(IndicatorHint, { props: { text: '合成方向说明', hover: true }, attachTo: document.body });
  const anchor = wrapper.get('.indicator-hint-anchor');
  await anchor.trigger('mouseenter');
  expect(document.querySelector('.indicator-hint-panel')).not.toBeNull();
  await anchor.trigger('mouseleave');
  expect(document.querySelector('.indicator-hint-panel')).toBeNull();
  await wrapper.get('button').trigger('focusin');
  expect(document.querySelector('.indicator-hint-panel')).not.toBeNull();
  await wrapper.get('button').trigger('focusout', { relatedTarget: null });
  expect(document.querySelector('.indicator-hint-panel')).toBeNull();
});

it('closes a clicked hint on outside pointer, Escape or changed text', async () => {
  wrapper = mount(IndicatorHint, { props: { text: '合成提示' }, attachTo: document.body });
  const button = wrapper.get('button');
  await button.trigger('click');
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await nextTick();
  expect(document.querySelector('.indicator-hint-panel')).toBeNull();
  await button.trigger('click');
  await button.trigger('keydown', { key: 'Escape' });
  expect(document.querySelector('.indicator-hint-panel')).toBeNull();
  await button.trigger('click');
  await wrapper.setProps({ text: '已更新的合成提示' });
  expect(document.querySelector('.indicator-hint-panel')).toBeNull();
});
