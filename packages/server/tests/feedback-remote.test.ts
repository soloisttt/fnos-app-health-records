import { validateFeedbackEnvironment } from '../services/feedback-validation';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sendFeedbackRequest } from '../services/feedback-remote.service';
test('feedback proxy uses fixed HTTPS destination, server identity, idempotency and no redirects',async()=>{
 let calls=0;
 const fetch:typeof globalThis.fetch=async (url,options)=>{calls++;assert.equal(String(url),'https://health.lby.link/api/v1/health/feedback/tickets');assert.equal(new Headers(options?.headers).get('x-client-id'),'synthetic');assert.equal(new Headers(options?.headers).get('Idempotency-Key'),'retry-test');assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).get('cookie'),null);return Response.json({success:true,data:{number:'B0001'}});};
 assert.deepEqual(await sendFeedbackRequest('/tickets',{method:'POST',key:'retry-test',json:true,body:'{}'},{fetch,identity:()=> 'synthetic'}),{number:'B0001'});assert.equal(calls,1);
});
test('upstream errors never expose response credentials, raw URLs or content',async()=>{
 const fetch:typeof globalThis.fetch=async ()=>Response.json({success:false,message:'SYNTHETIC_PRIVATE'},{status:409});
 await assert.rejects(sendFeedbackRequest('/tickets',{}, {fetch,identity:()=> 'synthetic'}),(error:any)=>error.status===409&&!String(error).includes('SYNTHETIC_PRIVATE'));
 const broken:typeof globalThis.fetch=async()=>{throw new Error('SYNTHETIC_PRIVATE');};
 await assert.rejects(sendFeedbackRequest('/tickets',{}, {fetch:broken,identity:()=> 'synthetic'}),(error:any)=>error.status===502&&!String(error).includes('SYNTHETIC_PRIVATE'));
});

test('environment rejects nested secrets and unapproved data before forwarding',()=>{
 assert.doesNotThrow(()=>validateFeedbackEnvironment({app:{version:'1'},ocr:{available:false}}));
 for(const value of [{app:{buildId:'secret'}},{ai:{apiKey:'secret'}},{reports:[]},{app:{version:{secret:'value'}}}]) assert.throws(()=>validateFeedbackEnvironment(value));
});
