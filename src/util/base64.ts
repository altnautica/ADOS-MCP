// URL-safe base64 helpers matching the ADOS capability-token wire format:
// standard base64url alphabet, padding stripped on encode, tolerant re-pad on
// decode (accepts both url-safe and standard alphabets). Mirrors the GCS
// canonical-token helpers so a token minted there decodes here byte-for-byte.

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(input: string): Uint8Array {
  // Normalize both url-safe and standard alphabets, then re-pad.
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

export function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
