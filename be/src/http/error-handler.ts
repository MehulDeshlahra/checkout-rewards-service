/**
 * Fastify error handler (design Section 11).
 *
 * Maps AppError -> { error: { code, message, details? } } + its httpStatus.
 * zod validation failures -> VALIDATION_ERROR (400) with field details.
 * Everything else -> 500 INTERNAL_ERROR with a generic message (no stack leak).
 */

import { ZodError } from "zod";
import { AppError, isAppError } from "../errors.js";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Register the central error handler on a Fastify instance. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    if (isAppError(err)) {
      reply.code(err.httpStatus).send(err.toBody());
      return;
    }

    // zod errors (thrown directly) -> VALIDATION_ERROR 400 with details.
    if (err instanceof ZodError) {
      const appErr = new AppError(
        "VALIDATION_ERROR",
        "request validation failed",
        err.issues,
      );
      reply.code(appErr.httpStatus).send(appErr.toBody());
      return;
    }

    // Fastify's own body-parse / validation errors (e.g. malformed JSON) -> 400.
    if (typeof err.statusCode === "number" && err.statusCode === 400) {
      const appErr = new AppError("VALIDATION_ERROR", "invalid request");
      reply.code(appErr.httpStatus).send(appErr.toBody());
      return;
    }

    // Unexpected: log at error level, return a generic 500 (no stack leak).
    _req.log.error({ err }, "unhandled error");
    const internal = new AppError("INTERNAL_ERROR", "internal server error");
    reply.code(internal.httpStatus).send(internal.toBody());
  });
}
