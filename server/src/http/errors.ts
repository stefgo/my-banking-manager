export class HttpError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

export const notFound = (what = "Eintrag"): HttpError => new HttpError(404, "not_found", `${what} nicht gefunden`);
export const badRequest = (message: string, code = "invalid"): HttpError => new HttpError(400, code, message);
export const conflict = (message: string, code = "conflict"): HttpError => new HttpError(409, code, message);
