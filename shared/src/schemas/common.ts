import { z } from "zod";
import { COLOR_KEYS, ICON_KEYS } from "../symbols.js";
import { isValidIsoDate } from "../dates.js";

export const Id = z.number().int().positive();
export const IdParam = z.object({ id: z.coerce.number().int().positive() });

export const IsoDate = z.string().refine(isValidIsoDate, "Datum im Format JJJJ-MM-TT");
export const Timestamp = z.string().describe("ISO 8601 date and time");

/** Whole cents; only EUR in v1. */
export const Cents = z.number().int().refine(Number.isSafeInteger, "Betrag zu groß");

export const IconKeySchema = z.enum(ICON_KEYS as [string, ...string[]]);
export const ColorKeySchema = z.enum(COLOR_KEYS as [string, ...string[]]);

export const Name = z.string().trim().min(1, "Bitte einen Namen eingeben").max(80, "Höchstens 80 Zeichen");

export const Ok = z.object({ ok: z.literal(true) });

export const ApiError = z.object({
    error: z.string().describe("Machine-readable code"),
    message: z.string().describe("German text for the user"),
});
export type ApiError = z.infer<typeof ApiError>;
