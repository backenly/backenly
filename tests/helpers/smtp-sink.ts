/**
 * A REAL SMTP SERVER, FOR PROVING MAIL ACTUALLY LEAVES
 * ===================================================
 *
 * `buildSmtpTransport` sets `requireTLS: true` on every non-465 port, so
 * nodemailer refuses to send to a server that does not offer STARTTLS. A sink
 * that skipped TLS would therefore test nothing: the send would fail for a
 * reason unrelated to whatever was being asserted.
 *
 * So this speaks real SMTP and performs a real STARTTLS upgrade:
 *
 *   220 greeting -> EHLO -> 250-STARTTLS -> TLS handshake -> EHLO -> AUTH ->
 *   MAIL FROM -> RCPT TO -> DATA -> 250 -> QUIT
 *
 * ── Why the certificate is generated, not committed ─────────────────────────
 *
 * A PEM private key in the repository would be a credential in a public
 * repository, and `scripts/preflight-oss.ts` would be right to fail the build
 * over it. So one is generated into a temp directory per run with `openssl`,
 * which is present on this machine and on the CI runners, and deleted after.
 * Nothing durable exists to leak.
 *
 * The certificate is self-signed, so the caller TRUSTS IT specifically via
 * `trustDuring()` rather than switching verification off. That distinction
 * matters: `NODE_TLS_REJECT_UNAUTHORIZED=0` would disable certificate checking
 * for every suite sharing the process, which could hide a genuine TLS fault
 * somewhere else in the same CI job. Adding one throwaway certificate to the
 * trust store leaves verification fully on and narrows the exception to this
 * server.
 *
 * (It also would not have worked: Node reads NODE_TLS_REJECT_UNAUTHORIZED when
 * the tls module initialises, so setting it in a beforeAll is already too
 * late.)
 *
 * ── What it records ─────────────────────────────────────────────────────────
 *
 * The AUTH credentials, the envelope, and the raw DATA. Assertions are made on
 * the bytes that arrived rather than on what the caller believes it sent, which
 * is the same standard the webhook suite holds.
 */

import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import tls from 'tls'

export interface ReceivedMail {
  /** Username the client authenticated as, decoded from AUTH. */
  username: string | null
  password: string | null
  mailFrom: string | null
  rcptTo: string[]
  /** The raw DATA payload, headers and body, exactly as it arrived. */
  raw: string
}

interface SelfSignedPair {
  key: string
  cert: string
  cleanup: () => void
}

/** A throwaway certificate for 127.0.0.1, valid for a day. */
function generateSelfSigned(): SelfSignedPair {
  const dir = mkdtempSync(join(tmpdir(), 'backenly-smtp-sink-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')

  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '1',
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'pipe' },
  )

  return {
    key: readFileSync(keyPath, 'utf8'),
    cert: readFileSync(certPath, 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

export class SmtpSink {
  private server!: net.Server
  private creds!: SelfSignedPair
  private openSockets = new Set<net.Socket>()
  readonly received: ReceivedMail[] = []
  /** The PEM this sink presents, so a caller can trust exactly it. */
  certificate = ''
  /** Set to a 5xx code to make the sink reject at DATA, proving the failure path. */
  rejectWith: string | null = null
  /**
   * Hold the reply to DATA this long, so a caller can prove it does NOT wait
   * for the provider. A response that returns while this is still pending
   * cannot have been timed by the send.
   */
  delayMs = 0
  port = 0

  async start(): Promise<void> {
    this.creds = generateSelfSigned()
    this.certificate = this.creds.cert

    this.server = net.createServer(socket => {
      this.openSockets.add(socket)
      socket.on('close', () => this.openSockets.delete(socket))
      socket.on('error', () => {})
      this.converse(socket, false, {
        username: null,
        password: null,
        mailFrom: null,
        rcptTo: [],
        raw: '',
      })
      socket.write('220 sink.test ESMTP ready\r\n')
    })

    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as net.AddressInfo).port
  }

  /**
   * Drive one connection's SMTP conversation.
   *
   * `secure` says whether this socket is already past STARTTLS, because AUTH is
   * only offered afterwards and the state has to survive the upgrade.
   */
  private converse(socket: net.Socket | tls.TLSSocket, secure: boolean, mail: ReceivedMail): void {
    let buffer = ''
    let inData = false
    let pendingAuth: 'login-user' | 'login-pass' | null = null

    const write = (line: string) => {
      if (!socket.destroyed) socket.write(line + '\r\n')
    }

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')

      // DATA is terminated by a lone dot on its own line, not by a newline.
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n')
        if (end === -1) return
        mail.raw = buffer.slice(0, end)
        buffer = buffer.slice(end + 5)
        inData = false
        const reply = () => {
          if (this.rejectWith) {
            write(`${this.rejectWith} message rejected by the sink`)
          } else {
            this.received.push({ ...mail, rcptTo: [...mail.rcptTo] })
            write('250 2.0.0 queued')
          }
        }
        if (this.delayMs > 0) setTimeout(reply, this.delayMs).unref?.()
        else reply()
        return
      }

      let idx: number
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const upper = line.toUpperCase()

        if (pendingAuth === 'login-user') {
          mail.username = Buffer.from(line, 'base64').toString('utf8')
          pendingAuth = 'login-pass'
          write('334 UGFzc3dvcmQ6')
          continue
        }
        if (pendingAuth === 'login-pass') {
          mail.password = Buffer.from(line, 'base64').toString('utf8')
          pendingAuth = null
          write('235 2.7.0 authenticated')
          continue
        }

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          // STARTTLS is advertised only before the upgrade; AUTH only after,
          // which is what a real server does and what makes nodemailer's
          // requireTLS path exercise the handshake.
          if (secure) {
            write('250-sink.test')
            write('250 AUTH PLAIN LOGIN')
          } else {
            write('250-sink.test')
            write('250 STARTTLS')
          }
        } else if (upper === 'STARTTLS') {
          write('220 2.0.0 ready to start TLS')
          socket.removeListener('data', onData)
          const upgraded = new tls.TLSSocket(socket as net.Socket, {
            isServer: true,
            key: this.creds.key,
            cert: this.creds.cert,
          })
          upgraded.on('error', () => {})
          // State carries across: the same `mail` object continues to fill in.
          this.converse(upgraded, true, mail)
        } else if (upper.startsWith('AUTH PLAIN')) {
          const payload = line.slice('AUTH PLAIN'.length).trim()
          if (payload) {
            // \0user\0pass
            const parts = Buffer.from(payload, 'base64').toString('utf8').split('\0')
            mail.username = parts[1] ?? null
            mail.password = parts[2] ?? null
            write('235 2.7.0 authenticated')
          } else {
            write('334 ')
          }
        } else if (upper.startsWith('AUTH LOGIN')) {
          pendingAuth = 'login-user'
          write('334 VXNlcm5hbWU6')
        } else if (upper.startsWith('MAIL FROM')) {
          mail.mailFrom = extractAddress(line)
          write('250 2.1.0 sender ok')
        } else if (upper.startsWith('RCPT TO')) {
          const addr = extractAddress(line)
          if (addr) mail.rcptTo.push(addr)
          write('250 2.1.5 recipient ok')
        } else if (upper === 'DATA') {
          inData = true
          write('354 end with <CRLF>.<CRLF>')
        } else if (upper === 'QUIT') {
          write('221 2.0.0 bye')
          socket.end()
        } else if (upper === 'RSET') {
          write('250 2.0.0 reset')
        } else {
          write('250 2.0.0 ok')
        }
      }
    }

    socket.on('data', onData)
  }

  async stop(): Promise<void> {
    // Sockets first, then the close. net.Server.close() only calls back once
    // every existing connection has ended, so awaiting it while one is open
    // waits for something nobody is doing.
    const closed = new Promise<void>(resolve => this.server.close(() => resolve()))
    for (const socket of this.openSockets) socket.destroy()
    this.openSockets.clear()
    await closed
    this.creds?.cleanup()
  }
}

function extractAddress(line: string): string | null {
  const match = line.match(/<([^>]*)>/)
  if (match) return match[1]
  const parts = line.split(':')
  return parts.length > 1 ? parts.slice(1).join(':').trim() : null
}

/**
 * Trust one extra certificate for the duration of a suite.
 *
 * ── Why this wraps tls.connect instead of setting the default trust store ───
 *
 * `tls.setDefaultCACertificates` is the obvious way to do this and it does not
 * exist on Node 20, which is what CI pins. The first version used it, passed
 * locally on Node 24, and failed every assertion in the suite on the runner with
 * `getCACertificates is not a function` — a reminder that "works on my machine"
 * includes the standard library's version.
 *
 * So instead every outgoing TLS connection gets this certificate ADDED to the
 * CA list it would otherwise use. `tls.rootCertificates` has been available
 * since Node 12, so the real CAs stay trusted and this cannot mask a
 * certificate problem anywhere else.
 *
 * Still additive, and still not `NODE_TLS_REJECT_UNAUTHORIZED=0`: verification
 * stays fully on, and the exception is one throwaway certificate rather than
 * every certificate in the process.
 */
export function trustCertificate(pem: string): () => void {
  const original = tls.connect as typeof tls.connect
  const patched = ((...args: any[]) => {
    // tls.connect has several overloads; the options object is whichever
    // argument is a non-null object that is not a callback.
    const options = args.find(a => a && typeof a === 'object' && !Array.isArray(a))
    if (options && options.ca === undefined) {
      options.ca = [...tls.rootCertificates, pem]
    }
    return (original as any)(...args)
  }) as typeof tls.connect

  ;(tls as any).connect = patched
  return () => {
    ;(tls as any).connect = original
  }
}
