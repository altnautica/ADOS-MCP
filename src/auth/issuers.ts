// Issuer classification and per-issuer verify-key resolution.
//
// A token's `iss` claim names the issuer family; the verifier resolves the key
// for that family. The self-contained-token families:
//   - agent:<deviceId> -> a key derived from the agent's pairing key by
//     HKDF-SHA256 under a domain-separation label DISTINCT from the plugin
//     capability token's, so a plugin token can never verify as an MCP token.
//   - local            -> a dev secret; the node claim check is skipped.
//   - cloud:<userId>   -> retained only to cleanly REJECT a legacy fleet HMAC
//     token: fleet-mode now authenticates with an opaque machine credential
//     verified against the backend (see gate/pipeline authenticateCredential),
//     not a self-contained HMAC token, so no cloud backend is wired here.
//
// The HKDF mechanism mirrors the platform's agent-token derivation; only the
// label differs. The single-HMAC ws-ticket / dashboard-session tokens use a
// different KDF and are unrelated here.

import { utf8 } from "../util/base64.js";

// Use the global Web Crypto (SubtleCrypto), so the key and buffer types line up
// with the DOM crypto types the rest of the code uses. This is the same API the
// GCS mints tokens with, so a token minted there verifies here byte-for-byte.
const subtle = globalThis.crypto.subtle;

export type IssuerKind = "cloud" | "agent" | "local";

export interface IssuerRef {
  kind: IssuerKind;
  subject: string;
}

export class TokenInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenInvalid";
  }
}

export function classifyIssuer(iss: string): IssuerRef {
  if (iss.startsWith("cloud:")) return { kind: "cloud", subject: iss.slice(6) };
  if (iss.startsWith("agent:")) return { kind: "agent", subject: iss.slice(6) };
  if (iss === "local") return { kind: "local", subject: "" };
  throw new TokenInvalid(`unknown issuer: ${iss}`);
}

// Domain-separation label for the agent-issued MCP token. Distinct from the
// plugin capability token label ("ados/plugin-capability-token/v1").
export const MCP_TOKEN_HKDF_LABEL = utf8("ados/mcp-token/v1");

/** Import raw bytes as an HMAC-SHA256 key usable for sign and verify. */
export async function importHmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify", "sign"],
  );
}

/**
 * Derive the agent-issuer HMAC key from the pairing key.
 * HKDF-SHA256(ikm = pairingKey bytes, salt = MCP label, info = revocationSalt).
 * `revocationSalt` folds into the derivation so a fresh salt (a "revoke all
 * tokens" action) or a re-pair (new pairing key) invalidates every prior token.
 */
export async function deriveAgentTokenSecret(
  pairingKey: string | Uint8Array,
  revocationSalt: Uint8Array = new Uint8Array(0),
): Promise<CryptoKey> {
  const ikm = typeof pairingKey === "string" ? utf8(pairingKey) : pairingKey;
  if (ikm.length === 0) {
    throw new TokenInvalid(
      "pairing key is empty; agent must be paired to derive the token secret",
    );
  }
  const baseKey = await subtle.importKey("raw", ikm as BufferSource, { name: "HKDF" }, false, [
    "deriveBits",
  ]);
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: MCP_TOKEN_HKDF_LABEL as BufferSource,
      info: revocationSalt as BufferSource,
    },
    baseKey,
    256,
  );
  return importHmacKey(new Uint8Array(bits));
}

/**
 * Resolves the candidate verify keys for a token, by issuer family. More than
 * one key supports secret rotation: the cloud issuer returns the current AND the
 * previous operator secret, so a token minted just before a rotation still
 * verifies until it expires. The verifier accepts the token if any key matches.
 */
export type SecretResolver = (ref: IssuerRef) => Promise<CryptoKey[]>;

/**
 * Build a resolver for a set of issuer backends. Any family without a backend
 * throws TokenInvalid, so a server that only supports one mode rejects tokens
 * of the other family rather than silently accepting them.
 */
export function makeResolver(backends: {
  agent?: { pairingKey: string; revocationSalt?: Uint8Array };
  cloud?: (userId: string) => Promise<Uint8Array[] | null>;
  local?: Uint8Array;
}): SecretResolver {
  return async (ref) => {
    switch (ref.kind) {
      case "agent": {
        if (!backends.agent) throw new TokenInvalid("agent issuer not supported by this server");
        return [
          await deriveAgentTokenSecret(backends.agent.pairingKey, backends.agent.revocationSalt),
        ];
      }
      case "cloud": {
        if (!backends.cloud) throw new TokenInvalid("cloud issuer not supported by this server");
        const secrets = await backends.cloud(ref.subject);
        if (!secrets || secrets.length === 0) {
          throw new TokenInvalid(`no operator secret for ${ref.subject}`);
        }
        return Promise.all(secrets.map((s) => importHmacKey(s)));
      }
      case "local": {
        if (!backends.local) throw new TokenInvalid("local issuer not supported by this server");
        return [await importHmacKey(backends.local)];
      }
    }
  };
}
