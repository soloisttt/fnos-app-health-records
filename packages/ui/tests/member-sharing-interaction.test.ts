import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import MemberManager from '../src/components/MemberManager.vue';
import { useConfirm } from '../src/composables/useConfirm';

const mocks = vi.hoisted(() => ({ request: vi.fn(), context: vi.fn(), refresh: vi.fn() }));
vi.mock('../src/utils/api', () => ({ request: mocks.request }));
vi.mock('../src/composables/useAppContext', () => ({ useAppContext: mocks.context }));
vi.mock('../src/composables/useScrollLock', () => ({ useScrollLock: () => {} }));
vi.mock('../src/composables/useToast', () => ({ useToast: () => ({ show: vi.fn() }) }));
const members = ['a', 'b'].map(id => ({ id, displayName: `fixture-${id}`, permission: 'manager', canManageSharing: true, relationship: 'other' }));
const accounts = [ { id: 'one', displayName: 'fixture', username: 'fixture-one' }, { id: 'two', displayName: 'fixture', username: 'fixture-two' } ];
const permissions = [{ userId: 'one', permission: 'manager', canManageSharing: false, version: 3 }];
const confirm = useConfirm();
let wrapper: ReturnType<typeof mount>;
function render() {
  wrapper = mount(MemberManager, { global: { stubs: { FormSelect: true, DateTimePicker: true } } });
  return wrapper;
}
async function open(index = 0) { await wrapper.findAll('[title="访问权限"]')[index].trigger('click'); await flushPromises(); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({ allMembers: ref(members), preferences: ref({ selfMemberId: 'a' }), session: ref({ id: 'owner', provider: 'local' }), refreshMembers: mocks.refresh });
  mocks.request.mockImplementation(async (path: string) => path.endsWith('sharing-accounts') ? accounts : permissions.map(p => ({ ...p })));
});
afterEach(() => { confirm.cancel(); wrapper?.unmount(); });

describe('sharing interaction boundaries', () => {
  it('cancelled delegation restores the checkbox and sends no mutation', async () => {
    render(); await open();
    const input = wrapper.get('.sharing-delegation input');
    await input.setValue(true);
    expect((input.element as HTMLInputElement).checked).toBe(false);
    expect(confirm.state.value?.message).toContain('fixture-one');
    expect(confirm.state.value?.message).toContain('fixture-a');
    confirm.cancel(); await flushPromises();
    expect((input.element as HTMLInputElement).checked).toBe(false);
    expect(mocks.request.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  });
  it('failed delegation keeps the original state; success updates it', async () => {
    render(); await open();
    const input = wrapper.get('.sharing-delegation input');
    mocks.request.mockRejectedValueOnce(new Error('synthetic failure'));
    await input.setValue(true); await confirm.confirm(); await flushPromises();
    expect((input.element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.text()).toContain('synthetic failure');
    mocks.request.mockResolvedValueOnce([{ ...permissions[0], canManageSharing: true, version: 4 }]);
    await input.setValue(true); await confirm.confirm(); await flushPromises();
    expect((input.element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.text()).not.toContain('synthetic failure');
  });
  it('ignores an older opening response after a different member was opened', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.request.mockImplementation(async (path: string) => {
      if (path === 'members/a/permissions') return new Promise(resolve => { resolveOld = resolve; });
      return path.endsWith('sharing-accounts') ? accounts : [{ ...permissions[0], canManageSharing: true }];
    });
    render(); await open(0); await open(1);
    resolveOld(permissions); await flushPromises();
    expect((wrapper.get('.sharing-delegation input').element as HTMLInputElement).checked).toBe(true);
    await wrapper.get('.sharing-delegation input').setValue(false);
    expect(confirm.state.value?.message).toContain('fixture-b');
    await confirm.confirm(); await flushPromises();
    const call = mocks.request.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(call?.[0]).toBe('members/b/permissions');
  });
  it('confirmation remains bound to its original member and version', async () => {
    render(); await open(0);
    await wrapper.get('.sharing-delegation input').setValue(true);
    await open(1);
    await confirm.confirm(); await flushPromises();
    const call = mocks.request.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(call?.[0]).toBe('members/a/permissions');
    expect(JSON.parse(call?.[1].body)).toMatchObject({ userId: 'one', version: 3, canManageSharing: true });
  });
  it('closing while loading prevents a late response from reopening the dialog', async () => {
    let resolve!: (value: unknown) => void;
    mocks.request.mockImplementation(async (path: string) => path.endsWith('sharing-accounts') ? accounts : new Promise(done => { resolve = done; }));
    render(); await open();
    await wrapper.get('[title="关闭"]').trigger('click');
    resolve(permissions); await flushPromises();
    expect(wrapper.find('[aria-label="访问权限"]').exists()).toBe(false);
  });
  it('distinguishes duplicate display names in both single and batch views', async () => {
    render(); await open();
    expect(wrapper.text()).toContain('fixture（fixture-one）');
    expect(wrapper.text()).toContain('fixture（fixture-two）');
    await wrapper.findAll('.sharing-member-options input')[1].setValue(true); await flushPromises();
    const select = wrapper.findAllComponents({ name: 'FormSelect' }).find(item => item.attributes('aria-label') === '接收账号' || item.props('ariaLabel') === '接收账号');
    expect(select?.props('options')).toEqual(accounts.map(account => ({ value: account.id, label: `fixture（${account.username}）` })));
  });
});
