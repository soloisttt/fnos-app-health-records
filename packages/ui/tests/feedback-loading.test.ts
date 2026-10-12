import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FeedbackPage from '../src/pages/settings/FeedbackSettingsPage.vue';

const request=vi.hoisted(()=>vi.fn());
vi.mock('../src/utils/api',()=>({request:(...args:unknown[])=>request(...args)}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>({refreshReminderCount:async()=>{}})}));
vi.mock('vue-router',()=>({useRoute:()=>({query:{}})}));
const ticket={number:'B0001',title:'合成反馈',category:'problem',status:'received',version:1,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
function pendingList() {
 let resolve!:(value:{items:typeof ticket[];total:number})=>void,reject!:(error:Error)=>void;
 const promise=new Promise<{items:typeof ticket[];total:number}>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
let page:VueWrapper;
function render() {return page=mount(FeedbackPage,{global:{stubs:{SubPageHeader:true,Teleport:true,FeedbackImageEditor:true}}});}
beforeEach(()=>{request.mockReset();request.mockResolvedValue({items:[ticket],total:40});});
afterEach(()=>{page?.unmount();vi.useRealTimers();});

it('shows skeletons and an accessible loading status before the first response, then shows the empty state',async()=>{
 const pending=pendingList();request.mockReturnValue(pending.promise);
 render();await flushPromises();
 expect(page.get('[aria-label="反馈列表"]').attributes('aria-busy')).toBe('true');
 expect(page.findAll('.feedback-skeleton-row')).toHaveLength(3);
 expect(page.get('.feedback-skeleton').attributes('aria-hidden')).toBe('true');
 expect(page.get('[role="status"]').text()).toBe('正在加载反馈…');
 expect(page.find('.feedback-empty').exists()).toBe(false);
 pending.resolve({items:[],total:0});await flushPromises();
 expect(page.get('[aria-label="反馈列表"]').attributes('aria-busy')).toBe('false');
 expect(page.find('.feedback-skeleton').exists()).toBe(false);
 expect(page.find('[role="status"]').exists()).toBe(false);
 expect(page.get('.feedback-empty').text()).toContain('还没有提交过反馈');
});

it('keeps rows visible but disabled while paging and clears loading after failure and retry',async()=>{
 render();await flushPromises();
 const pending=pendingList();request.mockReturnValue(pending.promise);
 await page.findAll('button').find(button=>button.text()==='下一页')!.trigger('click');
 expect(request).toHaveBeenLastCalledWith('feedback/tickets?page=2&pageSize=20',expect.anything());
 expect(page.get('.feedback-row').text()).toContain('合成反馈');
 expect(page.get('.feedback-row').attributes('disabled')).toBeDefined();
 expect(page.get('.feedback-list-loading').classes()).toContain('is-refreshing');
 expect(page.find('.feedback-skeleton').exists()).toBe(false);
 for(const button of page.findAll('button').filter(button=>['上一页','下一页'].includes(button.text()))) {
  expect(button.attributes('disabled')).toBeDefined();
 }
 pending.reject(new Error('合成连接失败'));await flushPromises();
 expect(page.find('[role="status"]').exists()).toBe(false);
 expect(page.get('[role="alert"]').text()).toContain('合成连接失败');
 expect(page.get('.feedback-row').attributes('disabled')).toBeUndefined();
 const retry=pendingList();request.mockReturnValue(retry.promise);
 await page.get('[role="alert"] button').trigger('click');
 expect(page.find('[role="alert"]').exists()).toBe(false);
 expect(page.get('.feedback-row').attributes('disabled')).toBeDefined();
 retry.resolve({items:[{...ticket,number:'B0002',title:'第二页反馈'}],total:40});await flushPromises();
 expect(page.find('[role="status"]').exists()).toBe(false);
 expect(page.get('.feedback-row').text()).toContain('第二页反馈');
 expect(page.get('.feedback-row').attributes('disabled')).toBeUndefined();
});

it('keeps the loading overlay until the latest search finishes and ignores an earlier response',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 render();await flushPromises();
 const first=pendingList(),second=pendingList();
 request.mockImplementation((path:string)=>path.includes('q=first')?first.promise:second.promise);
 await page.get('input[aria-label="搜索反馈"]').setValue('first');await vi.advanceTimersByTimeAsync(300);
 await page.get('input[aria-label="搜索反馈"]').setValue('second');await vi.advanceTimersByTimeAsync(300);
 expect(page.get('.feedback-row').attributes('disabled')).toBeDefined();
 first.resolve({items:[{...ticket,title:'旧搜索结果'}],total:1});await flushPromises();
 expect(page.get('[aria-label="反馈列表"]').attributes('aria-busy')).toBe('true');
 expect(page.get('.feedback-row').text()).toContain('合成反馈');
 second.resolve({items:[{...ticket,title:'最新搜索结果'}],total:1});await flushPromises();
 expect(page.get('[aria-label="反馈列表"]').attributes('aria-busy')).toBe('false');
 expect(page.get('.feedback-row').text()).toContain('最新搜索结果');
 expect(page.find('[role="status"]').exists()).toBe(false);
});
