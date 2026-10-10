import { createError, defineEventHandler, getRouterParam, readBody, setResponseStatus } from "h3";
import { createSymptom } from "../../../../services/episode.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "病程 ID 无效" });
  const body = ((await readBody(event)) || {}) as Record<string, unknown>;
  const result = createSymptom(getRequestUser(event), id, body);
  setResponseStatus(event, 201);
  return ok(result);
});
