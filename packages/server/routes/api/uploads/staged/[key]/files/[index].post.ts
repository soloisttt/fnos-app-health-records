import { defineEventHandler, getRouterParam } from 'h3';
import { getRequestUser } from '../../../../../../utils/request-user';
import { ok } from '../../../../../../utils/api-response';
import { readUploadFile } from '../../../../../../utils/read-upload-file';
import { assertStagedFileAccess, storeStagedFile } from '../../../../../../services/staged-upload.service';
export default defineEventHandler(async event => {
  const user = getRequestUser(event);
  const key = getRouterParam(event, 'key') || '';
  const index = Number(getRouterParam(event, 'index'));
  assertStagedFileAccess(user, key, index);
  const file = await readUploadFile(event);
  return ok(storeStagedFile(user, key, index, new Uint8Array(await file.arrayBuffer())));
});
