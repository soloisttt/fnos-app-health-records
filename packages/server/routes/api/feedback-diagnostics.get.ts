import { defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";
import { getRequestAccessMode } from "../../utils/access-mode";
import { getFeedbackDiagnostics } from "../../services/feedback-diagnostics.service";

export default defineEventHandler((event) => {
  getRequestUser(event);
  return ok(getFeedbackDiagnostics(getRequestAccessMode(event)));
});
