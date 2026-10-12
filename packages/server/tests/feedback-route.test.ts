import { getAppConfig } from '../utils/runtime-config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { H3 } from 'h3';
import { mkdtempSync,rmSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../routes/api/feedback/[...path]';
import { closeDatabaseForTests } from '../database/client';
import { readFeedbackInstallation } from '../services/feedback-installation.service';
import { getDatabase } from '../database/client';

test('local authenticated route forwards only feedback operations and edited image bytes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'feedback-route-')),env={...process.env},originalFetch=globalThis.fetch;
 process.env.STORAGE_DIR=dir;process.env.DISABLE_JOB_RUNNER='true';
 const calls:{url:string;headers:Headers;body?:BodyInit|null}[]=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),headers:new Headers(init?.headers),body:init?.body});return Response.json({success:true,data:String(url).endsWith('/feedback-attachments')?{id:1,url:'/uploads/example.png',relativePath:'private'}:init?.method==='POST'?{number:'B0001',status:'received',version:1}:{items:[],total:0}});};
 let authenticated=false;
 const app=new H3();app.use(e=>{e.context.requestUser={id:'synthetic',authenticated};});app.all('/api/feedback/**:path',handler);
 try {
  assert.equal((await app.request('http://localhost/api/feedback/tickets')).status,401);assert.equal(calls.length,0);assert.equal(readFeedbackInstallation(getDatabase()),null);
  assert.equal((await app.request('http://localhost/api/feedback/identity')).status,401);
  authenticated=true;
  const identityResponse=await app.request('http://localhost/api/feedback/identity');
  assert.equal(identityResponse.status,200);assert.equal(identityResponse.headers.get('cache-control'),'no-store');
  const identity=(await identityResponse.json()).data.clientId;assert.match(identity,/^[A-Za-z0-9_-]{43}$/);assert.equal(calls.length,0);

  assert.equal((await app.request('http://localhost/api/feedback/admin')).status,404);assert.equal(calls.length,0);
  assert.equal((await app.request('http://localhost/api/feedback/tickets?page=1')).status,200);
  assert.equal(calls[0].url,'https://gateway.lby.link/health/v1/feedbacks?page=1&pageSize=50');const id=calls[0].headers.get('x-client-id');assert.match(id!,/^[A-Za-z0-9_-]{43}$/);assert.equal(id,identity);assert.equal(calls[0].headers.get('x-version'),getAppConfig().appVersion);
  const form=new FormData();form.set('file',new Blob(['edited-synthetic-image'],{type:'image/png'}),'private-original-name.png');
  const uploaded=await app.request('http://localhost/api/feedback/upload',{method:'POST',headers:{'Idempotency-Key':'upload-test','x-client-id':'untrusted','cookie':'private'},body:form});assert.equal(uploaded.status,200);assert.deepEqual((await uploaded.json()).data,{id:1,url:'/uploads/example.png'});
  assert.equal(calls[1].headers.get('x-client-id'),id);assert.equal(calls[1].headers.get('cookie'),null);const file=(calls[1].body as FormData).get('file') as File;assert.equal(file.name,'screenshot.png');assert.equal(await file.text(),'edited-synthetic-image');assert.deepEqual(readdirSync(join(dir,'uploads')),[]);
  const submitted=await app.request('http://localhost/api/feedback/tickets',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'submit-test'},body:JSON.stringify({category:'suggestion',title:'合成标题',description:'合成说明',attachmentIds:[1]})});assert.equal(submitted.status,200);assert.equal(JSON.parse(String(calls[2].body)).appKey,'health-records');
  const bad=await app.request('http://localhost/api/feedback/tickets',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'submit-test'},body:JSON.stringify({clientId:'private'})});assert.equal(bad.status,400);assert.equal(calls.length,3);
 }finally{globalThis.fetch=originalFetch;closeDatabaseForTests();process.env=env;rmSync(dir,{recursive:true,force:true});}
});
