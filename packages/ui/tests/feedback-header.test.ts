import { it,expect,vi } from 'vitest';
import { requestFeedback } from '../src/utils/feedback-service';
const request=vi.hoisted(()=>vi.fn());
vi.mock('../src/utils/api',()=>({request}));
it('all feedback operations carry current identity and refresh it after restore',async()=>{
 let id='a'.repeat(43);
 request.mockImplementation(async(path:string)=>path==='feedback/identity'?{clientId:id}:{success:true});
 await requestFeedback('tickets');
 expect(request.mock.calls[1][1].headers['x-client-id']).toBe(id);
 id='b'.repeat(43);
 await requestFeedback('tickets/B0001/messages',{method:'POST',headers:{'Idempotency-Key':'retry-id','x-client-id':'forged'},body:'{}'});
 const options=request.mock.calls[3][1];expect(options.headers['x-client-id']).toBe(id);expect(options.headers['idempotency-key']).toBe('retry-id');
 request.mockImplementation(async()=>({clientId:'invalid'}));
 const before=request.mock.calls.length;await expect(requestFeedback('tickets')).rejects.toThrow('安装标识无效');expect(request.mock.calls.length).toBe(before+1);
});
