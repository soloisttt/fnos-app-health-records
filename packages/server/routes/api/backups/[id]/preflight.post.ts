import {createError,defineEventHandler,getRouterParam,readBody} from 'h3';
import {assertRestoreAdministrator} from '../../../../services/restore-access.service';
import {preflightStoredBackup} from '../../../../services/records.service';
import {getRequestUser} from '../../../../utils/request-user';
import {ok} from '../../../../utils/api-response';
export default defineEventHandler(async event=>{
 const user=getRequestUser(event);
 assertRestoreAdministrator(user);
 const body=await readBody<{takeover?:boolean}>(event);
 if(body?.takeover!==undefined && typeof body.takeover!=='boolean') throw createError({statusCode:400,statusMessage:'无效的接管选项'});
 return ok(preflightStoredBackup(user,getRouterParam(event,'id')||'',body?.takeover===true));
});
