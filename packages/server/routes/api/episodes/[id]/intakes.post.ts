import { createError, defineEventHandler, getRouterParam, readBody, setResponseStatus } from "h3";
import { createIntake } from "../../../../services/episode.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

/** 记一次服药（医生开的药或自己补录的药，点一下填个数就记一条）。 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "病程 ID 无效" });
  const body = ((await readBody(event)) || {}) as Record<string, unknown>;
  const result = createIntake(getRequestUser(event), id, body);
  setResponseStatus(event, 201);
  return ok(result);
});
