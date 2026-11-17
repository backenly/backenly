/**
 * A stand-in for a Postgres server behind TLS, for checking how a client
 * verifies the server's certificate. No Postgres is involved.
 *
 * It answers a client's SSLRequest with 'S', completes the TLS handshake with
 * the certificate it was given, and answers the startup message that follows
 * with an ErrorResponse carrying REACHED. So a client that verified the
 * certificate and went on fails with REACHED, and one that refused the
 * certificate fails with its own TLS error, before anything reached the server.
 *
 * makeCertificates creates, with the openssl command line, a throwaway CA, a
 * server certificate it signs for one host name only, and an unrelated second
 * CA. Nothing is written outside the directory it is given.
 */

import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import net from 'net'
import { join } from 'path'
import tls from 'tls'

export const REACHED = 'the stand-in was reached over TLS'

export interface Certificates {
  /** The CA that signed the server certificate. */
  caFile: string
  ca: string
  /** A CA that signed nothing here. */
  otherCaFile: string
  otherCa: string
  key: string
  cert: string
}

function openssl(dir: string, args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' })
}

function makeCa(dir: string, name: string): void {
  writeFileSync(
    join(dir, `${name}.cnf`),
    [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      '[dn]',
      `CN = ${name}`,
      '[v3_ca]',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n'),
  )
  openssl(dir, ['req', '-x509', '-new', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-keyout', `${name}.key`, '-out', `${name}.crt`, '-config', `${name}.cnf`, '-extensions', 'v3_ca'])
}

/** A CA, a server certificate it signs naming only `host`, and an unrelated CA. */
export function makeCertificates(dir: string, host: string): Certificates {
  makeCa(dir, 'test-ca')
  makeCa(dir, 'other-ca')
  writeFileSync(join(dir, 'server.cnf'), ['[req]', 'distinguished_name = dn', 'prompt = no', '[dn]', `CN = ${host}`, ''].join('\n'))
  writeFileSync(
    join(dir, 'server.ext'),
    [`subjectAltName = DNS:${host}`, 'basicConstraints = CA:FALSE', 'keyUsage = digitalSignature,keyEncipherment', 'extendedKeyUsage = serverAuth', ''].join('\n'),
  )
  openssl(dir, ['req', '-new', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-keyout', 'server.key', '-out', 'server.csr', '-config', 'server.cnf'])
  openssl(dir, ['x509', '-req', '-sha256', '-days', '2', '-in', 'server.csr', '-CA', 'test-ca.crt', '-CAkey', 'test-ca.key', '-set_serial', '2', '-out', 'server.crt', '-extfile', 'server.ext'])
  const read = (f: string) => readFileSync(join(dir, f), 'utf8')
  return {
    caFile: join(dir, 'test-ca.crt'),
    ca: read('test-ca.crt'),
    otherCaFile: join(dir, 'other-ca.crt'),
    otherCa: read('other-ca.crt'),
    key: read('server.key'),
    cert: read('server.crt'),
  }
}

/** An ErrorResponse message (Postgres protocol 3): severity, code and message. */
function errorResponse(message: string): Buffer {
  const fields = Buffer.concat([
    Buffer.from('SFATAL\0VFATAL\0C08006\0', 'utf8'),
    Buffer.from(`M${message}\0`, 'utf8'),
    Buffer.from([0]),
  ])
  const head = Buffer.alloc(5)
  head.write('E', 0)
  head.writeInt32BE(fields.length + 4, 1)
  return Buffer.concat([head, fields])
}

export interface StandIn {
  port: number
  close: () => Promise<void>
}

/** Listens on 127.0.0.1 with the given certificate. */
export async function startTlsPostgresStandIn(certs: Pick<Certificates, 'key' | 'cert'>): Promise<StandIn> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.once('data', () => {
      // The SSLRequest (length 8, code 80877103): yes, TLS.
      socket.write('S')
      const secure = new tls.TLSSocket(socket, { isServer: true, key: certs.key, cert: certs.cert })
      secure.on('error', () => {})
      secure.once('data', () => secure.end(errorResponse(REACHED)))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
