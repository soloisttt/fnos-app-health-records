import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, DOMWrapper } from '@vue/test-utils';
import { ref } from 'vue';
const mocks = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn(), authMode: 'local' }));
vi.mock('../src/utils/api', () => ({ request: mocks.request, requestUpload: vi.fn(), apiUrl: (path: string) => `/api/${path}` }));
vi.mock('../src/composables/useToast', () => ({ useToast: () => ({ show: mocks.toast }) }));
vi.mock('../src/composables/useAppContext', () => ({ useAppContext: () => ({
  session: ref({ authMode: mocks.authMode, isAdmin: true }), selectedMemberId: ref('synthetic-member'),
  selectedMember: ref({ displayName: '合成成员', permission: 'manager' }), notifyDataChanged: vi.fn()
}) }));
import UploadPage from '../src/pages/UploadPage.vue';
import UploadOrganizer from '../src/components/UploadOrganizer.vue';
let wrapper: ReturnType<typeof mount>;
const file = (name: string, size = 1024) => ({ name, path: name, type: 'file', size, modifiedAt: '' });
type Entry = ReturnType<typeof file>;
let entries = [file('synthetic-1.jpg'), file('synthetic-2.jpg')];
let directories: Record<string, Entry[]> = {};
const folder = (name: string) => ({ ...file(name), type: 'directory' });
const stubs = { RouterLink: true, ImageViewer: true, IndicatorHint: true, FormSelect: true };
beforeEach(() => {
  vi.clearAllMocks(); directories = {}; mocks.authMode = 'local'; entries = [file('synthetic-1.jpg'), file('synthetic-2.jpg')];
  mocks.request.mockImplementation(async (path: string) => {
    if (path === 'local-files/import') return { reportId: 'synthetic-report', status: 'queued' };
    const params = new URLSearchParams(path.split('?')[1]);
    return { roots: [{ id: 'root', label: '合成目录', path: '/reports' }], current: params.has('rootId') ? { rootId: 'root', path: params.get('path') || '' } : null,
      entries: directories[params.get('path') || ''] || entries, truncated: false, personalAuthorization: false, availability: { state: 'ready', configuredCount: 1, unavailableCount: 0, message: null } };
  });
});
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = ''; });
const view = () => new DOMWrapper(document.body);
async function open() {
  wrapper = mount(UploadPage, { attachTo: document.body, global: { stubs } });
  await view().get('.nas-import-button').trigger('click'); await flushPromises();
}
const boxes = () => view().findAll('.local-entry input[type="checkbox"]');
const organizer = () => view().get('.local-file-modal .upload-organizer');

it('selects two JPGs, settles rendering and submits both in one merged report', async () => {
  await open();
  await boxes()[0].setValue(true);
  await boxes()[1].setValue(true); await flushPromises();
  expect(view().get('.local-file-footer').text()).toContain('已选 2 个文件');
  await organizer().findAll('.organizer-modes button')[1].trigger('click'); await flushPromises();
  expect(view().get('.local-file-footer .primary-button').attributes('disabled')).toBeUndefined();
  await view().get('.local-file-footer .primary-button').trigger('click'); await flushPromises();
  const imports = mocks.request.mock.calls.filter(([path]) => path === 'local-files/import');
  expect(imports).toHaveLength(1);
  expect(JSON.parse(imports[0][1].body).files).toEqual(entries.map(e => ({ rootId: 'root', path: e.path })));
});

async function selectAll() {
  await view().get('.local-file-selection-actions button').trigger('click'); await flushPromises();
}
async function openFolder(name: string) {
  await view().findAll('.is-directory').find(row => row.text().includes(name))!.trigger('click'); await flushPromises();
}
async function root() {
  await view().get('.local-file-toolbar nav button').trigger('click'); await flushPromises();
}

it.each(['local', 'fnos'])('supports current-directory selection and preserves other directories in %s mode', async (authMode) => {
  mocks.authMode = authMode;
  entries = [folder('child'), file('root-a.jpg'), file('root-b.pdf')];
  directories.child = [file('child/child-a.jpg'), file('child/child-b.jpg')];
  await open(); await boxes()[0].setValue(true); await selectAll();
  expect(view().get('.local-file-footer').text()).toContain('已选 2 个文件');
  await openFolder('child'); await selectAll();
  expect(view().get('.local-file-footer').text()).toContain('已选 4 个文件');
  await selectAll();
  expect(view().get('.local-file-footer').text()).toContain('已选 2 个文件');
  await root(); expect(boxes().every(box => (box.element as HTMLInputElement).checked)).toBe(true);
  await selectAll(); expect(view().get('.local-file-footer').text()).toContain('已选 0 个文件');
});

it('skips oversized files and rejects total-size overflow without partially changing the selection', async () => {
  entries = [file('valid.jpg'), file('oversized.jpg', 41 * 1024 * 1024), folder('large')];
  directories.large = Array.from({ length: 52 }, (_, n) => file(`large/${n}.jpg`, 40 * 1024 * 1024));
  await open(); await selectAll();
  expect(view().get('.local-file-footer').text()).toContain('已选 1 个文件');
  expect(view().get('.local-file-error').text()).toContain('已跳过 1 个');
  await openFolder('large'); await selectAll();
  expect(view().get('.local-file-error').text()).toContain('2 GB');
  expect(view().get('.local-file-footer').text()).toContain('已选 1 个文件');
  expect(boxes().some(box => (box.element as HTMLInputElement).checked)).toBe(false);
});

it('enforces the cumulative 1000-file limit across directories', async () => {
  entries = [folder('first'), folder('second'), folder('third')];
  for (const [name, count] of [['first', 500], ['second', 500], ['third', 1]] as const) {
    directories[name] = Array.from({ length: count }, (_, n) => file(`${name}/${n}.jpg`));
  }
  await open(); await openFolder('first'); await selectAll();
  await root(); await openFolder('second'); await selectAll();
  expect(view().get('.local-file-footer').text()).toContain('已选 1000 个文件');
  await root(); await openFolder('third'); await selectAll();
  expect(view().get('.local-file-error').text()).toContain('1000 个文件');
  expect(view().get('.local-file-footer').text()).toContain('已选 1000 个文件');
});

it('does not emit duplicate plans for equivalent file arrays, but updates order and removals', async () => {
  wrapper = mount(UploadOrganizer, { attachTo: document.body, props: { files: [{ id: 'a', name: 'a.jpg' }, { id: 'b', name: 'b.jpg' }] }, global: { stubs } });
  await view().findAll('.organizer-modes button')[1].trigger('click');
  const count = wrapper.emitted('plan')!.length;
  await wrapper.setProps({ files: [{ id: 'a', name: 'renamed.jpg' }, { id: 'b', name: 'b.jpg' }] });
  expect(wrapper.emitted('plan')).toHaveLength(count);
  await wrapper.setProps({ files: [{ id: 'b', name: 'b.jpg' }, { id: 'a', name: 'a.jpg' }] });
  expect(wrapper.emitted('plan')!.at(-1)).toEqual([[['b', 'a']]]);
  await wrapper.setProps({ files: [{ id: 'a', name: 'a.jpg' }] });
  expect(wrapper.emitted('plan')!.at(-1)).toEqual([[['a']]]);
});
