import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { unlinkEpisodeFact } from "../../../../services/episode.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler((event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "病程 ID 无效" });
  const query = getQuery(event);
  const factType = typeof query.factType === "string" ? query.factType : "";
  const factId = typeof query.factId === "string" ? query.factId : "";
  return ok(unlinkEpisodeFact(getRequestUser(event), id, { factType, factId }));
});
