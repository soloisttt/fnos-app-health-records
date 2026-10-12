import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';
import RemindersPage from '../src/pages/RemindersPage.vue';
import FeedbackPage from '../src/pages/settings/FeedbackSettingsPage.vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),push:vi.fn(),refresh:vi.fn(),toast:vi.fn(),app:null as any,route:null as any}));
vi.mock('../src/utils/api',()=>({request:(...args:any[])=>mocks.request(...args)}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:()=>mocks.app}));
vi.mock('vue-router',()=>({useRouter:()=>({push:mocks.push}),useRoute:()=>mocks.route}));
vi.mock('../src/composables/useRefreshOnActivate',()=>({useRefreshOnActivate:()=>{}}));
vi.mock('../src/composables/usePullRefresh',()=>({usePullRefresh:()=>({pullDistance:0,refreshing:false})}));
vi.mock('../src/composables/useToast',()=>({useToast:()=>({show:mocks.toast})}));
const notice={id:'feedback_notice_synthetic',memberId:null,reportId:null,type:'feedback_updated',feedbackNumber:'B0001',title:'反馈进度更新',message:'反馈 B0001 已更新为已发布，待验证。',severity:'info',status:'unread',createdAt:'2026-01-01T00:00:00Z',readAt:null,reportTitle:null};
const ticket={number:'B0001',title:'合成反馈',category:'problem',status:'released_pending_verification',version:2,fixedVersion:'0.2.12',description:'合成说明',attachments:[],events:[],eventTotal:0,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
const options={global:{stubs:{EmptyState:true,DateTimePicker:true,PullIndicator:true,ReportDetailModal:true,SubPageHeader:true,Teleport:true,FeedbackImageEditor:true}}};
beforeEach(()=>{
 vi.clearAllMocks();mocks.route=reactive({query:{}});
 mocks.app={selectedMemberId:ref(''),session:ref({authenticated:true,isAdmin:true}),refreshReminderCount:mocks.refresh};
 mocks.refresh.mockResolvedValue(undefined);mocks.push.mockResolvedValue(undefined);
 mocks.request.mockImplementation(async(path:string)=>path==='notifications'?[notice]:path.startsWith('feedback/tickets/B0001')?ticket:{items:[],total:0});
});
it('administrator without members sees an application notification and opens its exact feedback',async()=>{
 const page=mount(RemindersPage,options);await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('notifications');expect(mocks.request.mock.calls.some(c=>c[0].startsWith('reminders'))).toBe(false);
 expect(page.text()).toContain('反馈 B0001');expect(page.text()).toContain('反馈更新');
 const view=page.findAll('button').find(b=>b.text()==='查看反馈')!;await view.trigger('click');await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('notifications/feedback_notice_synthetic',expect.objectContaining({method:'PUT',body:JSON.stringify({status:'read'})}));
 expect(mocks.push).toHaveBeenCalledWith({path:'/me/feedback',query:{feedback:'B0001'}});page.unmount();
});
it('archive uses this administrator notification endpoint without requiring a selected member',async()=>{
 const page=mount(RemindersPage,options);await flushPromises();
 await page.findAll('button').find(b=>b.text()==='知道了')!.trigger('click');await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('notifications/feedback_notice_synthetic',expect.objectContaining({body:JSON.stringify({status:'archived'})}));page.unmount();
});
it('ordinary user does not see administrator feedback notifications',async()=>{
 mocks.app.session.value.isAdmin=false;
 const page=mount(RemindersPage,options);await flushPromises();expect(page.text()).not.toContain('反馈 B0001');expect(page.text()).not.toContain('查看反馈');page.unmount();
});
it('feedback notification deep link opens a detail and normal page viewing does not mark all notifications read',async()=>{
 mocks.route.query.feedback='B0001';
 const page=mount(FeedbackPage,options);await flushPromises();
 expect(mocks.request).toHaveBeenCalledWith('feedback/tickets/B0001?eventPage=1&eventPageSize=10',expect.anything());
 expect(page.text()).toContain('合成反馈');expect(mocks.request.mock.calls.some(c=>c[0].startsWith('notifications/'))).toBe(false);page.unmount();
});
