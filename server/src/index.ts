import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { config } from './config.js'
import { DavAuthError } from './dav/auth.js'
import { evictClient } from './dav/client.js'
import { DisallowedHostError } from './dav/hostAllowlist.js'
import { originCheck } from './originCheck.js'
import { ContactNotFoundError, ForbiddenError, InvalidIdError } from './store/errors.js'
import { redactLogUrl } from './logRedaction.js'
import { registerSession } from './session.js'
import { sessionRoutes } from './routes/session.js'
import { addressBookRoutes } from './routes/addressbooks.js'
import { calendarRoutes } from './routes/calendars.js'
import { searchRoutes } from './routes/search.js'
import { sharingRoutes } from './routes/sharing.js'
import { subscriptionRoutes } from './routes/subscriptions.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  // Fastify's default max route-param length (100 chars) is too short for
  // this app's base64url-encoded calendar ids -- Radicale's shorter URLs
  // stayed under it by luck, but Baikal's longer `/dav.php/calendars/...`
  // paths exceed it, producing a 414 on every route with a real calendar id.
  const app = Fastify({
    // The default request serializer logs the full URL, query string and all.
    // Subscription feed URLs carry a secret token in the query string, so
    // override `req` to redact sensitive params before they're written out.
    logger: {
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: redactLogUrl(req.url),
            host: req.headers.host,
            remoteAddress: req.ip,
            remotePort: req.socket?.remotePort,
          }
        },
      },
    },
    routerOptions: { maxParamLength: 500 },
    trustProxy: config.trustProxy,
  })

  // A calendarId/href resolving to a different host than the authenticated
  // DAV server is a rejected SSRF attempt, not a server bug -- surface it
  // as 403, not the default 500 an uncaught throw would otherwise produce.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DavAuthError) {
      // The stored DAV credentials stopped working mid-session. End the
      // app session too (otherwise a reload's whoami would still pass and
      // land back here), and answer 401 so the client's session-expired
      // handling sends the user to /login.
      const dav = req.session?.get('dav')
      if (dav) evictClient(dav)
      req.session?.delete()
      reply.code(401).send({ error: 'dav_auth_failed', message: err.message })
      return
    }
    if (err instanceof ContactNotFoundError) {
      reply.code(404).send({ error: 'not_found', message: 'This contact no longer exists. It may have been deleted elsewhere.' })
      return
    }
    if (err instanceof InvalidIdError) {
      reply.code(400).send({ error: 'bad_request', message: err.message })
      return
    }
    if (err instanceof ForbiddenError) {
      reply.code(403).send({ error: 'forbidden', message: err.message })
      return
    }
    if (err instanceof DisallowedHostError) {
      reply.code(403).send({ error: 'host_not_allowed', message: err.message })
      return
    }
    if ((err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply
        .code(413)
        .send({ error: 'payload_too_large', message: 'File is too large to import' })
      return
    }
    // Anything else is unexpected: log it, but don't hand internals (stack
    // frames, library messages) to the client. 4xx errors Fastify raises
    // itself (bad JSON, validation, rate limit) are safe to pass through.
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) {
      reply.send(err)
      return
    }
    req.log.error({ err }, 'Unhandled error')
    reply.code(500).send({ error: 'internal_error', message: 'Internal server error' })
  })

  app.addHook('onRequest', originCheck)

  // .vcf imports arrive as plain text bodies.
  app.addContentTypeParser(
    ['text/vcard', 'text/x-vcard', 'text/plain'],
    { parseAs: 'string', bodyLimit: 20 * 1024 * 1024 },
    (_req, body, done) => {
      done(null, body)
    },
  )

  await registerSession(app)
  await app.register(sessionRoutes, { prefix: '/api/session' })
  await app.register(calendarRoutes, { prefix: '/api/calendars' })
  await app.register(searchRoutes, { prefix: '/api/search' })
  await app.register(sharingRoutes, { prefix: '/api/sharing' })
  await app.register(subscriptionRoutes, { prefix: '/api/subscriptions' })
  await app.register(addressBookRoutes, { prefix: '/api/addressbooks' })

  const clientDist = path.join(__dirname, '../../client/dist')
  await app.register(fastifyStatic, { root: clientDist })
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api')) {
      reply.code(404).send({ error: 'not_found', message: 'Unknown API route' })
      return
    }
    reply.sendFile('index.html')
  })

  await app.listen({ port: config.port, host: '0.0.0.0' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
