import { defineEventHandler, getRouterParam, setResponseHeader } from 'h3';
import { getMemberMerge } from '../../../../services/member-merge.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(event=>{setResponseHeader(event,'cache-control','no-store');return ok(getMemberMerge(getRequestUser(event),getRouterParam(event,'id')||''));});
