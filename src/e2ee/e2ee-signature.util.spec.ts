// Real Ed25519 keypairs, real signatures, real verification -- no mocking
// of node:crypto, since the whole point of this test is proving the utility
// actually interoperates with genuine Ed25519 key material (the format a
// real mobile E2EE library would produce), not just that some function
// returns a boolean.

import { generateKeyPairSync, sign } from 'crypto';
import { verifyEd25519Signature } from './e2ee-signature.util';

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function generateRealEd25519KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { publicKey, privateKey, publicKeyBase64Url: publicJwk.x };
}

describe('verifyEd25519Signature', () => {
  it('verifies a real, genuinely-signed message', () => {
    const { privateKey, publicKeyBase64Url } = generateRealEd25519KeyPair();
    const data = Buffer.from('a real signed-prekey public key payload');
    const signature = sign(null, data, privateKey);

    const result = verifyEd25519Signature(
      base64UrlEncode(data),
      publicKeyBase64Url,
      base64UrlEncode(signature),
    );
    expect(result).toBe(true);
  });

  it('rejects a signature over TAMPERED data', () => {
    const { privateKey, publicKeyBase64Url } = generateRealEd25519KeyPair();
    const data = Buffer.from('original data');
    const signature = sign(null, data, privateKey);
    const tamperedData = Buffer.from('tampered data!!');

    const result = verifyEd25519Signature(
      base64UrlEncode(tamperedData),
      publicKeyBase64Url,
      base64UrlEncode(signature),
    );
    expect(result).toBe(false);
  });

  it('rejects a signature verified against the WRONG public key', () => {
    const signer = generateRealEd25519KeyPair();
    const impostor = generateRealEd25519KeyPair();
    const data = Buffer.from('data signed by the real signer');
    const signature = sign(null, data, signer.privateKey);

    const result = verifyEd25519Signature(
      base64UrlEncode(data),
      impostor.publicKeyBase64Url, // wrong key
      base64UrlEncode(signature),
    );
    expect(result).toBe(false);
  });

  it('rejects a garbage/malformed public key without throwing', () => {
    const data = Buffer.from('data');
    expect(() =>
      verifyEd25519Signature(
        base64UrlEncode(data),
        'not-a-real-key',
        'not-a-real-signature',
      ),
    ).not.toThrow();
    expect(
      verifyEd25519Signature(
        base64UrlEncode(data),
        'not-a-real-key',
        'not-a-real-signature',
      ),
    ).toBe(false);
  });

  it('rejects empty data or signature', () => {
    const { publicKeyBase64Url } = generateRealEd25519KeyPair();
    expect(verifyEd25519Signature('', publicKeyBase64Url, 'c2ln')).toBe(false);
    expect(verifyEd25519Signature('ZGF0YQ', publicKeyBase64Url, '')).toBe(
      false,
    );
  });

  it('rejects a signature produced by a DIFFERENT algorithm/key type entirely', () => {
    // A well-formed-looking but structurally different key (RSA, say) must
    // never be silently accepted as if it were the expected Ed25519 key.
    const { publicKeyBase64Url } = generateRealEd25519KeyPair();
    const data = Buffer.from('data');
    const bogusSignature = Buffer.from(
      'this is not a real 64-byte ed25519 signature',
    );
    const result = verifyEd25519Signature(
      base64UrlEncode(data),
      publicKeyBase64Url,
      base64UrlEncode(bogusSignature),
    );
    expect(result).toBe(false);
  });
});
