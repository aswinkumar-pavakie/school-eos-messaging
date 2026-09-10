// The ONE real cryptographic operation this backend performs (LLD §46-47's
// trust boundary: it never touches plaintext or private keys). Verifies an
// Ed25519 signature using Node's built-in `crypto` module (JWK/OKP import) --
// a standard-library, already-audited primitive, never an invented
// algorithm.
//
// Signed-prekey convention (X3DH/Signal-protocol family, matching this LLD's
// own identity/signed-prekey/one-time-prekey vocabulary): the "data" being
// signed is simply the signed prekey's own raw public-key bytes, i.e.
// signature = Sign(identityPrivateKey, signedPrekeyPublicKeyBytes). Actually
// implementing the client-side protocol is out of scope for this
// backend-only build; this util only verifies what a client submits.
//
// All key/signature material here is base64url-encoded raw bytes (never
// PEM/DER) — base64url specifically because that's what Node's JWK `x` field
// requires.

import { createPublicKey, verify } from 'crypto';

export function verifyEd25519Signature(
  dataBase64Url: string,
  publicKeyBase64Url: string,
  signatureBase64Url: string,
): boolean {
  try {
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBase64Url },
      format: 'jwk',
    });
    const data = Buffer.from(dataBase64Url, 'base64url');
    const signature = Buffer.from(signatureBase64Url, 'base64url');
    if (data.length === 0 || signature.length === 0) return false;
    return verify(null, data, publicKey, signature);
  } catch {
    // Malformed key/signature material -- fail closed, never throw past this
    // boundary uncaught (a caller checking `if (!verifyEd25519Signature(...))`
    // must always get a clean boolean).
    return false;
  }
}
