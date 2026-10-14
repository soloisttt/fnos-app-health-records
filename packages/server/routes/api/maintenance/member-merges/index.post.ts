import { defineEventHandler, readBody, setResponseHeader, assertBodySize } from 'h3';
import { executeMemberMerge, requireMergeAdministrator } from '../../../../services/member-merge.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(async event => {
 setResponseHeader(event,'cache-control','no-store');
 const user=getRequestUser(event);
 requireMergeAdministrator(user);
 await assertBodySize(event, 32 * 1024);
 return ok(executeMemberMerge(user,(await readBody<{token?:unknown}>(event))?.token));
});
