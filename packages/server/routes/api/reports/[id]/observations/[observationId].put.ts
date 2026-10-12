import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getReportDetail } from "../../../../../services/records.service";
import { updateManualObservation } from "../../../../../services/observation-field-overrides.service";
import { ok } from "../../../../../utils/api-response";
import { getRequestUser } from "../../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const reportId = getRouterParam(event, "id");
  const observationId = getRouterParam(event, "observationId");
  if (!reportId || !observationId) throw createError({ statusCode: 400, statusMessage: "指标 ID 无效" });
  const user = getRequestUser(event);
  const input = (await readBody(event) || {}) as Record<string, unknown>;
  if (!Number.isInteger(input.expectedSourceVersion)) throw createError({ statusCode: 409, statusMessage: "请刷新报告后重新校对" });
  updateManualObservation(user, reportId, observationId, input);
  return ok(getReportDetail(user, reportId));
});
