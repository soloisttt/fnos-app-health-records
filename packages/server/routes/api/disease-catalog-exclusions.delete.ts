import { createError, defineEventHandler, getQuery } from "h3";
import { restoreCatalogEntry } from "../../services/episode.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

const allowedKinds = new Set(["diagnosis", "symptom"]);

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const memberId = typeof query.memberId === "string" ? query.memberId : "";
  const kind = typeof query.kind === "string" ? query.kind : "";
  const name = typeof query.name === "string" ? query.name : "";
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "缺少 memberId" });
  if (!allowedKinds.has(kind)) throw createError({ statusCode: 400, statusMessage: "分类无效" });
  if (!name.trim()) throw createError({ statusCode: 400, statusMessage: "名称不能为空" });
  return ok(restoreCatalogEntry(getRequestUser(event), memberId, kind as "diagnosis" | "symptom", name));
});
