import { defineEventHandler, getQuery, setResponseHeader } from 'h3';
import { getMergeSelection } from '../../../../services/member-merge.service';
import { getRequestUser } from '../../../../utils/request-user';
import { ok } from '../../../../utils/api-response';
export default defineEventHandler(event=>{setResponseHeader(event,'cache-control','no-store');const q=getQuery(event);return ok(getMergeSelection(getRequestUser(event),String(q.sourceId||''),String(q.targetId||'')));});
