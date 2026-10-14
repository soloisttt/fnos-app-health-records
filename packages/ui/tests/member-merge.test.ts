import {describe,it,expect,vi,beforeEach} from 'vitest';
import {ref} from 'vue';
import {mount,flushPromises} from '@vue/test-utils';
import Page from '../src/pages/settings/MemberMergeSettingsPage.vue';
const mocks=vi.hoisted(()=>({request:vi.fn(),refresh:vi.fn(),context:vi.fn()}));
vi.mock('../src/utils/api',()=>({request:mocks.request}));
vi.mock('../src/composables/useAppContext',()=>({useAppContext:mocks.context}));
const candidate=(id:string)=>({id,displayName:id,creatorName:'fixture',selfName:null,reportCount:1});
const account={userId:'owner',displayName:'fixture',permission:'manager',canManageSharing:true,usable:true};
const fields={display_name:'target',birth_date:null,sex:null,blood_type_abo:null,blood_type_rh:null};
beforeEach(()=>{vi.clearAllMocks();mocks.context.mockReturnValue({session:ref({isAdmin:true}),refreshMembers:mocks.refresh});mocks.refresh.mockResolvedValue(undefined);});
function render(){return mount(Page,{global:{stubs:{SubPageHeader:true}}});}
async function click(w:ReturnType<typeof render>,text:string){const b=w.findAll('button').find(b=>b.text()===text);expect(b).toBeDefined();await b!.trigger('click');await flushPromises();}
describe('member merge',()=>{
 it('does not load global member information for an ordinary account',async()=>{mocks.context.mockReturnValue({session:ref({isAdmin:false})});const w=render();await flushPromises();expect(mocks.request).not.toHaveBeenCalled();expect(w.text()).toContain('仅管理员');});
 it('requires explicit confirmation and submits only selected permissions and the preview token',async()=>{
 mocks.request.mockImplementation(async(path:string)=>{
 if(path.includes('candidates'))return {items:[candidate('source'),candidate('target')],total:2};
 if(path.includes('selection'))return {source:fields,target:fields,sourceAccounts:[account,{...account,userId:'source-only',displayName:'source-only',permission:'viewer',canManageSharing:false}],targetAccounts:[account],selfAccounts:[{userId:'owner',displayName:'fixture',memberId:'target',usable:true},{userId:'source-only',displayName:'source-only',memberId:'source',usable:true}]};
 if(path.endsWith('preview'))return {token:'fixture-token',reportCount:1,warning:'权限将变化',resolvedFields:fields,selfResolution:{retained:{userId:'owner',displayName:'fixture'},released:[{userId:'source-only',displayName:'source-only'}]}};
 return {reportCount:1};
 });
 const w=render();await flushPromises();const cards=w.findAll('.candidate');await cards[0].findAll('button')[0].trigger('click');await cards[1].findAll('button')[1].trigger('click');await click(w,'核对合并结果');
 await click(w,'生成确认预览');expect(w.text()).toContain('解除本人关联');const call=mocks.request.mock.calls.find(c=>String(c[0]).endsWith('preview'))!;expect(JSON.parse(call[1].body).selfUserId).toBe('owner');expect(JSON.parse(call[1].body).grants).toEqual([{userId:'owner',permission:'manager',canManageSharing:true}]);
 const execute=w.findAll('button').find(b=>b.text()==='确认合并')!;expect(execute.attributes('disabled')).toBeDefined();await w.find('.confirmation input').setValue(true);await click(w,'确认合并');expect(w.text()).toContain('合并完成');expect(mocks.refresh).toHaveBeenCalledOnce();
 expect(JSON.parse(mocks.request.mock.calls.at(-1)![1].body)).toEqual({token:'fixture-token'});
 });
 it('offers retry after load failure without exposing report content',async()=>{mocks.request.mockRejectedValue(new Error('加载失败'));const w=render();await flushPromises();expect(w.find('[role=alert]').text()).toBe('加载失败');expect(w.findAll('img')).toHaveLength(0);});
});
