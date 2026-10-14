import { defineEventHandler, getQuery, setResponseHeader } from 'h3';
import { listMergeCandidates } from '../../../../services/member-merge.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(event=>{setResponseHeader(event,'cache-control','no-store');return ok(listMergeCandidates(getRequestUser(event),getQuery(event)));});
