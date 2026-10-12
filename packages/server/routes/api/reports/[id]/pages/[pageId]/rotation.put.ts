import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { rotateReportPage } from "../../../../../../services/records.service";
import { getRequestUser } from "../../../../../../utils/request-user";
import { ok } from "../../../../../../utils/api-response";

export default defineEventHandler(async event => {
  const reportId = getRouterParam(event, "id");
  const pageId = getRouterParam(event, "pageId");
  if (!reportId || !pageId) throw createError({ statusCode: 400, statusMessage: "报告页面 ID 无效" });
  return ok(rotateReportPage(getRequestUser(event), reportId, pageId, (await readBody(event)) || {}));
});
