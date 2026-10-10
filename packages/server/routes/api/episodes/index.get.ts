import { createError, defineEventHandler, getQuery } from "h3";
import { listEpisodes } from "../../../services/episode.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  const memberId = getQuery(event).memberId;
  if (typeof memberId !== "string" || !memberId) {
    throw createError({ statusCode: 400, statusMessage: "缺少 memberId" });
  }
  return ok(listEpisodes(getRequestUser(event), memberId));
});
