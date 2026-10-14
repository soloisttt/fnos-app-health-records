import { defineEventHandler, setResponseHeader, setResponseStatus } from 'h3';
import { initializeDatabaseForStartup } from '../database/client';
import { getAppConfig } from '../utils/runtime-config';
import { storageMigrationPaused } from '../utils/storage-migration-state';
import { fail } from '../utils/api-response';

// Before storage controls and authentication: neither may mutate an unsupported database.
export default defineEventHandler(event => {
  const config = getAppConfig();
  if (config.storageError || storageMigrationPaused()) return;
  const state = initializeDatabaseForStartup();
  if (!state || !('reason' in state)) return;
  setResponseStatus(event, 503);
  setResponseHeader(event, 'cache-control', 'no-store');
  const message = `当前数据库为 v${state.databaseVersion}，已安装应用仅支持 v${state.supportedVersion}，请安装支持该数据库版本的新版应用。`;
  const path = new URL(event.req.url).pathname;
  if (event.method !== 'GET' || path.includes('/api/') || path.endsWith('/healthz')) {
    return fail(message, { status: 503, code: 'DATABASE_UNAVAILABLE', maintenance: state });
  }
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8');
  const instruction = config.authMode === 'fnos'
    ? '请管理员在飞牛应用中心安装兼容版本，然后重新打开应用。'
    : config.authMode === 'local'
      ? '请管理员更新为兼容版本的 Docker 镜像并重新创建容器，保留原有数据目录。'
      : '请更新为兼容版本的应用，然后重新启动服务。';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>应用版本不兼容 · 健康档案</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#f4f6fa;color:#243047;font:14px/1.8 system-ui,sans-serif}main{width:100%;max-width:520px;padding:28px;background:white;border:1px solid #e3e8ef;border-radius:16px}h1{font-size:21px;margin:0 0 16px}p{margin:12px 0}button{margin-top:12px;padding:10px 18px;background:#3268d9;color:white;border:0;border-radius:8px;font:inherit;cursor:pointer}.muted{color:#667085}</style>
<main><h1>需要更新应用才能继续使用</h1><p>${message}</p><p>${instruction}</p>
<p class="muted">业务访问和后台任务已暂停。不会自动降低数据库版本或清空数据。若必须使用旧版应用，请联系管理员评估恢复升级前备份；备份之后新增的数据不包含在该备份内。</p>
<button type="button" onclick="location.reload()">重新检查</button></main></html>`;
});
