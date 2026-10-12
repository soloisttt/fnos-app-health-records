import { createError, defineEventHandler, readBody } from "h3";
import { excludeCatalogEntry } from "../../services/episode.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

const allowedKinds = new Set(["diagnosis", "symptom"]);

export default defineEventHandler(async (event) => {
  const body = ((await readBody(event)) || {}) as {
    memberId?: unknown;
    kind?: unknown;
    name?: unknown;
  };
  const memberId = typeof body.memberId === "string" ? body.memberId : "";
  const kind = typeof body.kind === "string" ? body.kind : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "缺少 memberId" });
  if (!allowedKinds.has(kind)) throw createError({ statusCode: 400, statusMessage: "分类无效" });
  if (!name.trim()) throw createError({ statusCode: 400, statusMessage: "名称不能为空" });
  return ok(excludeCatalogEntry(getRequestUser(event), memberId, kind as "diagnosis" | "symptom", name));
});
