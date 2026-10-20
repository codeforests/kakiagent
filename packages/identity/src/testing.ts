import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal OpenID provider for tests (FEAT-005 T4): discovery, JWKS and a token
 * endpoint that checks the code, the client secret and the PKCE verifier, and signs an
 * RS256 ID token. Tests read state, nonce and the challenge from the authorization URL
 * and mint a code with `issueCode`, standing in for the user's consent at Google.
 */
export interface TestOidcProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** A code for the given authorization URL, carrying these claims (and the URL's nonce). */
  issueCode(
    authorizationUrl: string,
    claims: Record<string, unknown>,
    opts?: { nonce?: string },
  ): string;
  close(): Promise<void>;
}

export async function startTestOidcProvider(): Promise<TestOidcProvider> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  const clientId = 'kaki-test-client';
  const clientSecret = randomBytes(16).toString('hex');
  const codes = new Map<
    string,
    { challenge: string; nonce: string; claims: Record<string, unknown> }
  >();
  let issuer = '';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        void (async () => {
          const form = new URLSearchParams(body);
          let id = form.get('client_id');
          let secret = form.get('client_secret');
          const basic = req.headers.authorization;
          if (basic?.startsWith('Basic ')) {
            const [u, p] = Buffer.from(basic.slice(6), 'base64').toString().split(':');
            id = decodeURIComponent(u ?? '');
            secret = decodeURIComponent(p ?? '');
          }
          if (id !== clientId || secret !== clientSecret)
            return json(401, { error: 'invalid_client' });
          const entry = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (!entry || entry.challenge !== challenge) return json(400, { error: 'invalid_grant' });
          const idToken = await new SignJWT({ ...entry.claims, nonce: entry.nonce })
            .setProtectedHeader({ alg: 'RS256', kid: 'test' })
            .setIssuer(issuer)
            .setAudience(clientId)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);
          json(200, {
            access_token: 'at',
            token_type: 'Bearer',
            expires_in: 300,
            id_token: idToken,
          });
        })();
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    issueCode(authorizationUrl, claims, opts) {
      const u = new URL(authorizationUrl);
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        challenge: u.searchParams.get('code_challenge') ?? '',
        nonce: opts?.nonce ?? u.searchParams.get('nonce') ?? '',
        claims,
      });
      return code;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
