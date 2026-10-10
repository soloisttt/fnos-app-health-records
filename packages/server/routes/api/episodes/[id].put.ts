import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { updateEpisode } from "../../../services/episode.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "病程 ID 无效" });
  const body = ((await readBody(event)) || {}) as Record<string, unknown>;
  return ok(updateEpisode(getRequestUser(event), id, body));
});
