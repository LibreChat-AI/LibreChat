import { z } from 'zod';
import {
  createPublicKey,
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const context = Buffer.from('librechat-sdk-provider-text/v1');
const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
const publicKeySchema = base64.length(60);
const envelopeSchema = z
  .object({
    version: z.literal(1),
    publicKey: publicKeySchema,
    nonce: base64.length(16),
    tag: base64.length(24),
    ciphertext: base64,
  })
  .strict();
type Envelope = z.infer<typeof envelopeSchema>;

function publicKey(value: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(publicKeySchema.parse(value), 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'x25519') throw new Error('Invalid SDK policy key');
  return key;
}

function deriveKey(privateKey: KeyObject, peerKey: KeyObject, nonce: Buffer): Buffer {
  const secret = diffieHellman({ privateKey, publicKey: peerKey });
  try {
    return Buffer.from(hkdfSync('sha256', secret, nonce, context, 32));
  } finally {
    secret.fill(0);
  }
}

/** Per-run private key stays on the host; recovery journals receive ciphertext and public keys only. */
export function createPolicyReceiver(maxBytes: number): {
  publicKey: string;
  open(envelope: unknown): string;
  dispose(): void;
} {
  const pair = generateKeyPairSync('x25519');
  let privateKey: KeyObject | undefined = pair.privateKey;
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    open: (input) => {
      if (!privateKey) throw new Error('SDK policy receiver closed');
      const envelope = envelopeSchema.parse(input);
      if (envelope.ciphertext.length > Math.ceil(maxBytes / 3) * 4)
        throw new Error('SDK policy payload exceeds limit');
      const nonce = Buffer.from(envelope.nonce, 'base64');
      const key = deriveKey(privateKey, publicKey(envelope.publicKey), nonce);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(context);
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
        if (ciphertext.length > maxBytes) throw new Error('SDK policy payload exceeds limit');
        const pending = decipher.update(ciphertext);
        try {
          const final = decipher.final();
          const plaintext = Buffer.concat([pending, final]);
          try {
            return plaintext.toString('utf8');
          } finally {
            plaintext.fill(0);
            final.fill(0);
          }
        } finally {
          pending.fill(0);
        }
      } finally {
        key.fill(0);
      }
    },
    dispose: () => {
      privateKey = undefined;
    },
  };
}

/** Encrypt before handing the candidate to a peer, queue, or replay log. */
export function createPolicySender(
  receiverKey: string,
  maxBytes: number,
): (text: string) => Envelope {
  const recipient = publicKey(receiverKey);
  return (text) => {
    if (Buffer.byteLength(text) > maxBytes) throw new Error('SDK policy payload exceeds limit');
    const pair = generateKeyPairSync('x25519');
    const nonce = randomBytes(12);
    const key = deriveKey(pair.privateKey, recipient, nonce);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(context);
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return {
        version: 1,
        publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    } finally {
      key.fill(0);
    }
  };
}
