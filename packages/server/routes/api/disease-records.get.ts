import { createError, defineEventHandler, getQuery } from "h3";
import { listDiseaseRecords } from "../../services/episode.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const memberId = typeof query.memberId === "string" ? query.memberId : "";
  const kind = query.kind === "symptom" ? "symptom" : "diagnosis";
  const name = typeof query.name === "string" ? query.name.trim() : "";
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "缺少 memberId" });
  if (!name) throw createError({ statusCode: 400, statusMessage: "缺少疾病名称" });
  return ok(listDiseaseRecords(getRequestUser(event), memberId, kind, name));
});
