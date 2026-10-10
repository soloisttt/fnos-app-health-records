import { createError, defineEventHandler, getQuery } from "h3";
import { searchVisits } from "../../services/episode.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const memberId = typeof query.memberId === "string" ? query.memberId : "";
  const keyword = typeof query.q === "string" ? query.q : "";
  if (!memberId) throw createError({ statusCode: 400, statusMessage: "缺少 memberId" });
  return ok(searchVisits(getRequestUser(event), memberId, keyword));
});
