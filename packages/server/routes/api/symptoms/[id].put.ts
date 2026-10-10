import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { updateSymptom } from "../../../services/episode.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "症状 ID 无效" });
  const body = ((await readBody(event)) || {}) as Record<string, unknown>;
  return ok(updateSymptom(getRequestUser(event), id, body));
});
