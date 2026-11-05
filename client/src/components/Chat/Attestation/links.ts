import type { TNearAIReceipt } from 'librechat-data-provider';

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * NEAR AI verify page for one reply. The receipt goes in the fragment, which the
 * browser never sends to the server; it holds only hashes and the signature.
 */
export function receiptVerifyLink(verifyUrl: string, receipt: TNearAIReceipt): string | undefined {
  if (!receipt.signature || !receipt.signedText || !receipt.signingAddress) {
    return undefined;
  }
  const payload = {
    completionId: receipt.completionId,
    model: receipt.model,
    signatureKind: receipt.signatureKind,
    signingAlgo: receipt.signingAlgo,
    signingAddress: receipt.signingAddress,
    signedText: receipt.signedText,
    signature: receipt.signature,
    verifiedAt: receipt.verifiedAt,
  };
  const url = new URL(verifyUrl);
  url.searchParams.set('model', receipt.model);
  url.hash = `receipt=${toBase64Url(JSON.stringify(payload))}`;
  return url.toString();
}
