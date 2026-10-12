import { createError } from 'h3';
const fields:Record<string,string[]>={app:['version'],deployment:['type','accessMode'],server:['platform','arch','kernelVersion','nodeVersion'],database:['schemaVersion'],ocr:['available','engine','modelVersion','pythonVersion','rapidocrVersion','pymupdfVersion','tableModel','layoutModel'],ai:['enabled','visionEnabled'],client:['browserName','browserVersion','osName','viewportWidth','viewportHeight']};
export function validateFeedbackEnvironment(value:unknown) {
  if(value===undefined) return;
  const invalid=()=>{throw createError({statusCode:400,statusMessage:'环境信息包含不支持的字段或内容'});};
  if(!value || typeof value!=='object' || Array.isArray(value)) return invalid();
  for(const [group,items] of Object.entries(value)) {
    if(!Object.hasOwn(fields,group) || !items || typeof items!=='object' || Array.isArray(items)) return invalid();
    for(const [key,item] of Object.entries(items)) if(!fields[group].includes(key) || !(item===null || typeof item==='boolean' || typeof item==='number'&&Number.isFinite(item) || typeof item==='string'&&item.length<=120)) return invalid();
  }
  if(Buffer.byteLength(JSON.stringify(value))>16384) invalid();
}
