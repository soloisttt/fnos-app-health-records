import { createError, defineEventHandler, getRouterParam } from "h3";
import { getEpisode } from "../../../services/episode.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "病程 ID 无效" });
  return ok(getEpisode(getRequestUser(event), id));
});
