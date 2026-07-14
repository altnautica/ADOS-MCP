// The self-contained MCP bearer token: a canonical-JSON claims blob signed with
// HMAC-SHA256, wire form `base64url(blob).base64url(sig)`. Verified against a key
// the issuer family resolves (see issuers.ts). The verifier hashes the received
// blob bytes, never a re-serialization, so mint and verify agree on the exact
// bytes.

import { canonicalJson } from "./canonical.js";
import { classifyIssuer, TokenInvalid, type SecretResolver } from "./issuers.js";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "../util/base64.js";
import { SCOPE_GROUPS, type ScopeGroup } from "./scopes.js";

const subtle = globalThis.crypto.subtle;

export interface TokenClaims {
  /** Stable id for audit and single-token revocation. Never secret. */
  tokenId: string;
  /** Who minted it. Ties every call to a human in the audit log. */
  operatorId: string;
  /** Issuer family plus subject: "cloud:<userId>" | "agent:<deviceId>" | "local". */
  iss: string;
  /** Scope groups this token holds. Frozen at mint. */
  scopes: ScopeGroup[];
  /** Device ids this token may target. Empty means the single implicit node. */
  allowedNodes: string[];
  /** Path prefixes the files.* tools may read or write. */
  allowedRoots: string[];
  /** Optional source CIDRs the token is pinned to. Loopback always allowed. */
  sourceIpCidr: string[];
  /** Milliseconds since the Unix epoch. */
  expiresAt: number;
  /** If true, flight and destructive calls need a fresh operator-present signal. */
  operatorPresentRequired: boolean;
  /** Human hint shown in the Access Control view. */
  label: string;
}

export interface VerifyOptions {
  /** This device's id, for the agent-issuer subject check. Omit to skip. */
  expectedNodeId?: string;
  /** Wall clock in ms, for testability. Defaults to Date.now(). */
  now?: number;
}

interface ParsedToken {
  claims: TokenClaims;
  blob: Uint8Array;
  signature: Uint8Array;
}

function parseToken(token: string): ParsedToken {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    throw new TokenInvalid("malformed token: expected blob.signature");
  }
  const blob = fromBase64Url(token.slice(0, dot));
  const signature = fromBase64Url(token.slice(dot + 1));
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(blob));
  } catch {
    throw new TokenInvalid("malformed token: claims are not valid JSON");
  }
  return { claims: assertClaims(parsed), blob, signature };
}

function assertClaims(value: unknown): TokenClaims {
  if (typeof value !== "object" || value === null) {
    throw new TokenInvalid("malformed token: claims are not an object");
  }
  const c = value as Record<string, unknown>;
  const str = (k: string): string => {
    if (typeof c[k] !== "string") throw new TokenInvalid(`malformed token: ${k} must be a string`);
    return c[k] as string;
  };
  const strArr = (k: string): string[] => {
    const v = c[k];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new TokenInvalid(`malformed token: ${k} must be a string array`);
    }
    return v as string[];
  };
  const scopes = strArr("scopes");
  for (const s of scopes) {
    if (!SCOPE_GROUPS.includes(s as ScopeGroup)) {
      throw new TokenInvalid(`malformed token: unknown scope ${s}`);
    }
  }
  if (typeof c.expiresAt !== "number" || !Number.isFinite(c.expiresAt)) {
    throw new TokenInvalid("malformed token: expiresAt must be a number");
  }
  return {
    tokenId: str("tokenId"),
    operatorId: str("operatorId"),
    iss: str("iss"),
    scopes: scopes as ScopeGroup[],
    allowedNodes: strArr("allowedNodes"),
    allowedRoots: strArr("allowedRoots"),
    sourceIpCidr: strArr("sourceIpCidr"),
    expiresAt: c.expiresAt,
    operatorPresentRequired: c.operatorPresentRequired === true,
    label: typeof c.label === "string" ? c.label : "",
  };
}

/**
 * Verify a token and return its claims. Throws TokenInvalid on a bad signature,
 * expiry, malformed blob, unknown issuer, or node-claim mismatch.
 */
export async function verifyToken(
  token: string,
  resolver: SecretResolver,
  opts: VerifyOptions = {},
): Promise<TokenClaims> {
  const { claims, blob, signature } = parseToken(token);
  const ref = classifyIssuer(claims.iss);

  // Try each candidate key the resolver returns (a family may supply more than
  // one to bridge a key rotation). Accept on the first match; a constant-time
  // compare runs inside subtle.verify per key.
  const keys = await resolver(ref);
  let ok = false;
  for (const key of keys) {
    if (await subtle.verify("HMAC", key, signature as BufferSource, blob as BufferSource)) {
      ok = true;
      break;
    }
  }
  if (!ok) throw new TokenInvalid(`${ref.kind} signature mismatch`);

  const now = opts.now ?? Date.now();
  if (claims.expiresAt <= now) throw new TokenInvalid("token expired");

  if (ref.kind === "agent" && opts.expectedNodeId && ref.subject !== opts.expectedNodeId) {
    throw new TokenInvalid(
      `agent issuer ${ref.subject} does not match this node ${opts.expectedNodeId}`,
    );
  }
  return claims;
}

/**
 * Mint a token: canonical-serialize the claims, sign with the resolved key,
 * emit `base64url(blob).base64url(sig)`. Used by the dev CLI and the test suite;
 * the GCS mints the production tokens with the identical algorithm.
 */
export async function mintToken(claims: TokenClaims, key: CryptoKey): Promise<string> {
  const canonical = canonicalJson(claims as unknown as Record<string, unknown>);
  const blob = utf8(canonical);
  const sig = new Uint8Array(await subtle.sign("HMAC", key, blob as BufferSource));
  return `${toBase64Url(blob)}.${toBase64Url(sig)}`;
}
