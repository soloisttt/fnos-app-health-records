import { createError, defineEventHandler } from 'h3';
import { applyRestoreTakeoverRepair, preflightRestoreTakeoverRepair } from '../../../services/restore-takeover-repair.service';
import { assertRestoreAdministrator } from '../../../services/restore-access.service';
import { getRequestUser } from '../../../utils/request-user';
import { withMultipartUpload } from '../../../utils/read-multipart-upload';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(event => {
  const user = getRequestUser(event);
  assertRestoreAdministrator(user);
  return withMultipartUpload(event, {
    requestBytes: 1024 ** 3, fileBytes: 1024 ** 3, files: 1,
    sizeMessage: '备份文件大小超过限制（最大 1024MB）'
  }, ({ files, fields }) => {
    const backup = files.find(file => file.name === 'backup' && file.filename);
    if (!backup || !/\.tar\.gz$/i.test(backup.filename || '')) throw createError({ statusCode: 400, statusMessage: '请选择原始完整备份文件（.tar.gz）' });
    return ok(fields.token ? applyRestoreTakeoverRepair(user, backup.path, fields.token) : preflightRestoreTakeoverRepair(user, backup.path));
  });
});
