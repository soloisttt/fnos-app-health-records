import { getAppConfig } from '../utils/runtime-config';
import { deploymentType, feedbackUserAgent } from '../utils/deployment';
import { validateFeedbackEnvironment } from '../services/feedback-validation';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sendFeedbackRequest } from '../services/feedback-remote.service';
test('feedback proxy uses fixed HTTPS destination, server identity, idempotency and no redirects',async()=>{
 let calls=0;
 const fetch:typeof globalThis.fetch=async (url,options)=>{calls++;assert.equal(String(url),'https://gateway.lby.link/health/v1/feedbacks');assert.equal(new Headers(options?.headers).get('x-client-id'),'synthetic');assert.equal(new Headers(options?.headers).get('x-version'), getAppConfig().appVersion);assert.equal(new Headers(options?.headers).get('Idempotency-Key'),'retry-test');assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).get('cookie'),null);return Response.json({success:true,data:{number:'B0001'}});};
 assert.deepEqual(await sendFeedbackRequest('/tickets',{method:'POST',key:'retry-test',json:true,body:'{}'},{fetch,identity:()=> 'synthetic'}),{number:'B0001'});assert.equal(calls,1);
});
test('all feedback operations use an application UA without forwarding browser or installation details',async()=>{
 const config=getAppConfig();let calls=0;
 const fetch:typeof globalThis.fetch=async (_url,options)=>{
  const headers=new Headers(options?.headers);assert.equal(headers.get('user-agent'),feedbackUserAgent(config.appVersion,deploymentType(config.authMode)));
  assert.equal(headers.get('x-version'),config.appVersion);assert.doesNotMatch(headers.get('user-agent')!,/synthetic|Mozilla|AppleWebKit/);calls++;
  return Response.json({success:true,data:{items:[],total:0}});
 };
 for(const path of ['/tickets?page=1&pageSize=50','/tickets/B0001','/upload','/tickets','/tickets/B0001/messages','/tickets/B0001/resolution']) await sendFeedbackRequest(path,{}, {fetch,identity:()=> 'synthetic'});
 assert.equal(calls,6);
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
