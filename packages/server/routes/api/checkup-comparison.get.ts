import { createError, defineEventHandler, getQuery } from "h3";
import { compareCheckupReport } from "../../services/checkup-comparison.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

/** 体检报告「与上次对比」：这次和上一份体检逐项比，哪些变好、哪些变差 */
export default defineEventHandler((event) => {
  const reportId = typeof getQuery(event).reportId === "string" ? (getQuery(event).reportId as string) : "";
  if (!reportId) throw createError({ statusCode: 400, statusMessage: "缺少 reportId" });
  return ok(compareCheckupReport(getRequestUser(event), reportId));
});
