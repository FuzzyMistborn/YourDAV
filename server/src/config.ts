function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  sessionSecret: required('SESSION_SECRET'),
  // Both the encrypted session payload's own expiry (@fastify/secure-session's
  // `expiry` option, checked server-side against a timestamp baked into the
  // payload) and the cookie's `maxAge` are tied to this -- previously only
  // the former was set (implicitly, to the library's 24h default) and the
  // cookie had no maxAge at all, making it a browser-session cookie that's
  // wiped on browser close regardless of the 24h the payload allowed for.
  // SESSION_TTL_DAYS is expressed in days (not seconds) for readability;
  // converted here to the seconds the session/cookie logic below expects.
  sessionTtlSeconds: Number(process.env.SESSION_TTL_DAYS ?? 1) * 86400,
  // Fixed DAV server for every login. When set, the login form hides its
  // Server URL field and the server ignores any serverUrl the client sends,
  // so users can't point this instance at a different host. A full URL with
  // scheme (used as-is, no https-then-http fallback), unlike
  // allowedDavHosts below, which is bare hostnames.
  davServerUrl: process.env.DAV_SERVER_URL?.trim() || null,
  allowedDavHosts: process.env.ALLOWED_DAV_HOSTS
    ? process.env.ALLOWED_DAV_HOSTS.split(',').map((h) => h.trim())
    : null,
  // Upper bound, in ms, on any single outbound request (DAV or
  // subscription feed) -- without it a server that accepts the connection
  // and then stalls would hold the request open forever.
  outboundTimeoutMs: Number(process.env.OUTBOUND_TIMEOUT_MS ?? 30000),
  // Set when running behind a reverse proxy so the client IP (used for login
  // rate limiting) comes from X-Forwarded-For rather than the proxy's own
  // address. Leave false when exposed directly: the header is spoofable.
  trustProxy: process.env.TRUST_PROXY === 'true',
  // Max POST /api/session attempts per client IP per minute.
  loginRateLimitMax: Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 10),
  cacheEnabled: process.env.CACHE_ENABLED === 'true',
  sqlitePath: process.env.SQLITE_PATH ?? './data/cache.db',
  cacheSyncTtlMs: Number(process.env.CACHE_SYNC_TTL_MS ?? 30000),
  // Fallback timezone the client pre-selects for a *new* event, in place of
  // the browser's own auto-detected zone -- useful for a shared/kiosk
  // instance, or an admin who just wants everyone defaulting to one org
  // timezone rather than wherever each browser happens to think it is. Not
  // validated against the IANA tz database here; an invalid value just
  // means the client's <select> won't have a matching option pre-selected
  // (see EventEditDialog.vue), not a startup failure.
  defaultTimezone: process.env.DEFAULT_TIMEZONE || null,
  // Baked into the Docker image at build time (APP_VERSION build arg, set
  // to the git tag by CI for release builds). Anything unset/blank means an
  // unreleased build, shown as "dev".
  version: process.env.APP_VERSION || 'dev',
}
