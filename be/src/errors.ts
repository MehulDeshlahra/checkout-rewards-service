/**
 * Error model (design Section 11).
 *
 * A single AppError carries a stable machine-readable `code`, the HTTP status
 * to return, a human message, and optional details. All domain services throw
 * AppError; the Fastify error handler maps it to the common body + status.
 */

/** Stable, machine-readable error codes. */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_QUANTITY"
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_UNAVAILABLE"
  | "CART_NOT_FOUND"
  | "LINE_NOT_FOUND"
  | "ORDER_NOT_FOUND"
  | "CART_EMPTY"
  | "CART_ALREADY_CHECKED_OUT"
  | "INSUFFICIENT_INVENTORY"
  | "COUPON_NOT_FOUND"
  | "COUPON_NOT_REDEEMABLE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "NO_MILESTONE_REACHED"
  | "MILESTONE_ALREADY_REWARDED"
  | "INTERNAL_ERROR";

/** Log level associated with each error code (design Section 11). */
export type LogLevel = "debug" | "info" | "warn" | "error";

interface ErrorSpec {
  httpStatus: number;
  logLevel: LogLevel;
}

/**
 * The full error registry: HTTP status + log level for every stable code.
 * This is the single source of truth mapped by the HTTP error handler.
 */
export const ERROR_CODES: Record<ErrorCode, ErrorSpec> = {
  VALIDATION_ERROR: { httpStatus: 400, logLevel: "debug" },
  INVALID_QUANTITY: { httpStatus: 400, logLevel: "debug" },
  PRODUCT_NOT_FOUND: { httpStatus: 404, logLevel: "debug" },
  PRODUCT_UNAVAILABLE: { httpStatus: 409, logLevel: "info" },
  CART_NOT_FOUND: { httpStatus: 404, logLevel: "debug" },
  LINE_NOT_FOUND: { httpStatus: 404, logLevel: "debug" },
  ORDER_NOT_FOUND: { httpStatus: 404, logLevel: "debug" },
  CART_EMPTY: { httpStatus: 422, logLevel: "info" },
  CART_ALREADY_CHECKED_OUT: { httpStatus: 409, logLevel: "info" },
  INSUFFICIENT_INVENTORY: { httpStatus: 409, logLevel: "info" },
  COUPON_NOT_FOUND: { httpStatus: 422, logLevel: "info" },
  COUPON_NOT_REDEEMABLE: { httpStatus: 409, logLevel: "info" },
  IDEMPOTENCY_KEY_REUSED: { httpStatus: 422, logLevel: "warn" },
  NO_MILESTONE_REACHED: { httpStatus: 409, logLevel: "info" },
  MILESTONE_ALREADY_REWARDED: { httpStatus: 409, logLevel: "info" },
  INTERNAL_ERROR: { httpStatus: 500, logLevel: "error" },
};

/** Application error with a stable code and its mapped HTTP status. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly logLevel: LogLevel;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = ERROR_CODES[code].httpStatus;
    this.logLevel = ERROR_CODES[code].logLevel;
    this.details = details;
    // Keep the prototype chain correct when targeting older runtimes.
    Object.setPrototypeOf(this, AppError.prototype);
  }

  /** The common error body shape (design Section 10). */
  toBody(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

/** Type guard for AppError. */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
