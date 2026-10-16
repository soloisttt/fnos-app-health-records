import { createError, defineEventHandler, getQuery } from "h3";
import { listRelatedEpisodes } from "../../services/episode.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

/** 某个诊断 / 症状出现在哪几次生病（病程）里 —— 疾病 ↔ 病程 双向跳转的另一半 */
export default defineEventHandler((event) => {
  const query = getQuery(event);
  const memberId = typeof query.memberId === "string" ? query.memberId : "";
  const kind = query.kind === "symptom" ? "symptom" : "diagnosis";
  const name = typeof query.name === "string" ? query.name.trim() : "";
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "缺少 memberId" });
  if (!name) throw createError({ statusCode: 400, statusMessage: "缺少疾病名称" });
  return ok(listRelatedEpisodes(getRequestUser(event), memberId, kind, name));
});
