import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { H3 } from 'h3';
import { getDatabase, closeDatabaseForTests } from '../database/client';
import { startStagedUpload } from '../services/staged-upload.service';
import upload from '../routes/api/uploads.post';
import staged from '../routes/api/uploads/staged/[key]/files/[index].post';
import errorHandler from '../error-handler';
import { getAppConfig } from '../utils/runtime-config';

test('upload routes reject unauthorized requests before reading any body bytes', async () => {
  const previous = process.env.STORAGE_DIR;
  const root = mkdtempSync(join(tmpdir(),'upload-preflight-'));
  process.env.STORAGE_DIR = root;
  const owner = {id:'owner',displayName:'Synthetic',authenticated:true,provider:'local',isGatewayAdmin:false} as const;
  try {
    const db = getDatabase();
    db.exec(`INSERT INTO users(id,display_name) VALUES('owner','Synthetic');
      INSERT INTO health_members(id,display_name,created_by) VALUES('member','Synthetic','owner');
      INSERT INTO member_permissions(member_id,user_id,permission,granted_by) VALUES('member','owner','manager','owner');`);
    const key = 'synthetic-upload-key';
    startStagedUpload(owner,key,{memberId:'member',files:[{originalName:'synthetic.png',size:9,rotation:0}]});
    let user = {...owner,authenticated:false};
    const app = new H3({onError:errorHandler});
    const prefix = getAppConfig().gatewayPrefix;
    app.use(event => {event.context.requestUser = user;});
    app.post(`${prefix}/api/upload`,upload);
    app.post(`${prefix}/api/stage/:key/:index`,staged);
    async function send(path: string, status: number) {
      let bytesRead = 0;
      const body = new ReadableStream<Uint8Array>({pull(controller) {
        bytesRead += 1024;
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      }},{highWaterMark:0});
      const init: RequestInit & {duplex:'half'} = {method:'POST',body,headers:{'content-type':'multipart/form-data; boundary=synthetic'},duplex:'half'};
      const response = await app.request(`http://localhost${prefix}/api${path}`,init);
      assert.equal(response.status,status,await response.text());
      assert.equal(bytesRead,0,path);
    }
    await send('/upload',401);
    await send(`/stage/${key}/0`,401);
    user = {...owner};
    await send(`/stage/${key}/99`,400);
    await send('/stage/synthetic-missing-key/0',404);
    db.exec("UPDATE member_permissions SET permission='viewer' WHERE member_id='member'");
    await send(`/stage/${key}/0`,403);
  } finally {
    closeDatabaseForTests();
    if (previous === undefined) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previous;
    rmSync(root,{recursive:true,force:true});
  }
});
