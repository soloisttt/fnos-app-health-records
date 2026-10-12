import { defineEventHandler } from 'h3';
import { getRestoreTakeoverRepairStatus } from '../../../services/restore-takeover-repair.service';
import { getRequestUser } from '../../../utils/request-user';
import { ok } from '../../../utils/api-response';
export default defineEventHandler(event => ok(getRestoreTakeoverRepairStatus(getRequestUser(event))));
