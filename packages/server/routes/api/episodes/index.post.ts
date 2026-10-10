import { createError, defineEventHandler, readBody, setResponseStatus } from "h3";
import { createEpisode } from "../../../services/episode.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler(async (event) => {
  const body = ((await readBody(event)) || {}) as Record<string, unknown>;
  if (typeof body.memberId !== "string" || !body.memberId) {
    throw createError({ statusCode: 400, statusMessage: "缺少 memberId" });
  }
  const created = createEpisode(getRequestUser(event), body.memberId, body);
  setResponseStatus(event, 201);
  return ok(created);
});
