import { randomBytes } from "node:crypto";
import { ZodError } from "zod";
import { log } from "./logger";

export type ErrorCode = "not_found" | "validation" | "conflict" | "invalid_state" | "forbidden" | "unavailable";

/** An error the interface can show as is. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

const STATUS_BY_CODE: Record<ErrorCode, number> = { not_found: 404, validation: 400, conflict: 409, invalid_state: 409, forbidden: 403, unavailable: 503 };

export function errorReply(err: unknown): { status: number; body: { error: { code: string; message: string; details?: unknown } } } {
  if (err instanceof AppError) return { status: STATUS_BY_CODE[err.code], body: { error: { code: err.code, message: err.message, details: err.details ?? null } } };
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join(".") || "entrée"} : ${i.message}`).join(" · ");
    return { status: 400, body: { error: { code: "validation", message } } };
  }
  const e = err as { statusCode?: number; message?: string };
  if (e.statusCode && e.statusCode < 500) return { status: e.statusCode, body: { error: { code: "bad_request", message: e.message ?? "Requête invalide." } } };
  log.error("unhandled error", { error: e.message ?? String(err) });
  return { status: 500, body: { error: { code: "internal", message: "Une erreur est survenue. Vos données n'ont pas été modifiées." } } };
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function newId(prefix: string, length = 12): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}
