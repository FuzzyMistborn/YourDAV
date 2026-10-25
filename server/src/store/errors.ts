/** Thrown when a write is rejected because the resource changed since the client last read it (HTTP 412). */
export class EtagConflictError extends Error {}

/** Thrown when a contact card isn't on the server any more (HTTP 404), e.g. it was deleted from another client. */
export class ContactNotFoundError extends Error {}

/** Thrown when a client-supplied collection id or href isn't a well-formed encoding of a URL (HTTP 400). */
export class InvalidIdError extends Error {}

/** Thrown when a write targets a resource the caller doesn't have permission to modify (HTTP 403). */
export class ForbiddenError extends Error {}
