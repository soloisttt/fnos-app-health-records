import { request } from './api';
import { createUuid } from './uuid';
export const feedbackStatus:Record<string,string>={received:'已收到',needs_info:'待补充',confirmed:'已确认',in_progress:'处理中',fixed_pending_release:'已修复，待发布',released_pending_verification:'已发布，待验证',resolved:'已解决',closed:'已关闭'};
export const feedbackCategory:Record<string,string>={problem:'使用问题',suggestion:'功能建议',other:'其他反馈'};
export type FeedbackImage={id:number;url:string};
export type FeedbackEvent={id:number;type:string;actorType:string;content:string;fromStatus?:string;toStatus?:string;fixedVersion?:string;createdAt:string;attachments:FeedbackImage[]};
export type FeedbackTicket={number:string;title:string;category:string;status:string;fixedVersion:string|null;version:number;createdAt:string;updatedAt:string;description?:string;reproductionSteps?:string;attachments?:FeedbackImage[];events?:FeedbackEvent[];eventTotal?:number;environment?:Record<string,Record<string,unknown>>};
export function feedbackImageUrl(url:string) {
  try {const target=new URL(url,'https://health.lby.link');return target.protocol==='https:'?target.href:'';}catch{return '';}
}
export function createFeedbackOperation() {
  const keys=new Map<string,{signature:string;key:string}>();
  return {key(action:string,signature:string) {const prior=keys.get(action);if(prior?.signature===signature) return prior.key;const key=createUuid();keys.set(action,{signature,key});return key;},clear(action?:string){if(action)keys.delete(action);else keys.clear();}};
}
// Read the current persisted identity for each operation, including after backup restore.
// Coalesce concurrent reads only; never persist the credential in browser storage.
let identityRequest: Promise<{clientId:string}> | undefined;
export async function requestFeedback<T>(path:string,init?:RequestInit):Promise<T> {
  const pending=identityRequest ??= request<{clientId:string}>('feedback/identity');
  let identity: {clientId:string};
  try {identity=await pending;} finally {if(identityRequest===pending) identityRequest=undefined;}
  if(!/^[A-Za-z0-9_-]{43}$/.test(identity.clientId)) throw new Error('应用安装标识无效，请稍后重试');
  const headers:Record<string,string>={};
  new Headers(init?.headers).forEach((value,key)=>{headers[key.toLowerCase()]=value;});
  headers['x-client-id']=identity.clientId;
  return request<T>('feedback/'+path,{...init,headers});
}
export function postFeedback<T>(path:string,body:unknown,key:string) {return requestFeedback<T>(path,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)});}
