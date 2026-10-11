import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { updateReportFields } from "../../../services/records.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const reportId = getRouterParam(event, "id");
  if (!reportId) throw createError({ statusCode: 400, statusMessage: "报告 ID 无效" });
  const input = (await readBody(event) || {}) as Record<string, unknown>;
  if (!Number.isInteger(input.expectedSourceVersion)) throw createError({statusCode:409,statusMessage:'请刷新报告后重新校对'});
  return ok(updateReportFields(getRequestUser(event), reportId, input));
});
