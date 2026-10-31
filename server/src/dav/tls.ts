import { Agent } from 'undici'
import { config } from '../config.js'

let agent: Agent | null = null

/**
 * `fetch` for requests to the DAV server. Identical to the global fetch
 * unless DAV_INSECURE_TLS=true, in which case the server's TLS certificate
 * is not verified (self-signed / internal-CA development servers). Scoped to
 * DAV traffic only; subscription feeds keep normal verification.
 */
export function davHttpFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!config.davInsecureTls) return fetch(input, init)
  agent ??= new Agent({ connect: { rejectUnauthorized: false } })
  return fetch(input, { ...init, dispatcher: agent } as RequestInit)
}
