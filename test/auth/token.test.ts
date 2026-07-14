import { describe, it, expect } from "vitest";
import { mintToken, verifyToken, type TokenClaims } from "../../src/auth/token.js";
import {
  importHmacKey,
  deriveAgentTokenSecret,
  makeResolver,
  TokenInvalid,
} from "../../src/auth/issuers.js";
import { TEST_SECRET } from "../helpers.js";

function claims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  return {
    tokenId: "tk-1",
    operatorId: "cloud:usr_1",
    iss: "local",
    scopes: ["read", "safe_write"],
    allowedNodes: ["ados-skynodepi"],
    allowedRoots: ["/var/ados/"],
    sourceIpCidr: [],
    expiresAt: Date.now() + 60_000,
    operatorPresentRequired: false,
    label: "test",
    ...overrides,
  };
}

describe("token mint + verify (local issuer)", () => {
  const resolver = makeResolver({ local: TEST_SECRET });

  it("round-trips a valid token", async () => {
    const key = await importHmacKey(TEST_SECRET);
    const token = await mintToken(claims(), key);
    const verified = await verifyToken(token, resolver);
    expect(verified.tokenId).toBe("tk-1");
    expect(verified.scopes).toEqual(["read", "safe_write"]);
    expect(verified.allowedNodes).toEqual(["ados-skynodepi"]);
  });

  it("rejects a tampered signature", async () => {
    const key = await importHmacKey(TEST_SECRET);
    const token = await mintToken(claims(), key);
    const [blob] = token.split(".");
    const tampered = `${blob}.AAAA`;
    await expect(verifyToken(tampered, resolver)).rejects.toThrow(TokenInvalid);
  });

  it("rejects a wrong-key signature", async () => {
    const otherKey = await importHmacKey(new Uint8Array(32).fill(9));
    const token = await mintToken(claims(), otherKey);
    await expect(verifyToken(token, resolver)).rejects.toThrow(/signature mismatch/);
  });

  it("rejects an expired token", async () => {
    const key = await importHmacKey(TEST_SECRET);
    const token = await mintToken(claims({ expiresAt: Date.now() - 1000 }), key);
    await expect(verifyToken(token, resolver)).rejects.toThrow(/expired/);
  });

  it("rejects a malformed token", async () => {
    await expect(verifyToken("not-a-token", resolver)).rejects.toThrow(TokenInvalid);
    await expect(verifyToken("aaa.bbb.ccc.ddd", resolver)).rejects.toThrow(TokenInvalid);
  });

  it("rejects an unknown issuer", async () => {
    const key = await importHmacKey(TEST_SECRET);
    const token = await mintToken(claims({ iss: "bogus:x" }), key);
    await expect(verifyToken(token, resolver)).rejects.toThrow(/unknown issuer/);
  });
});

describe("token mint + verify (agent issuer, HKDF from pairing key)", () => {
  const pairingKey = "pairing-key-abc123";

  it("round-trips with the derived key and honors the node claim", async () => {
    const key = await deriveAgentTokenSecret(pairingKey);
    const token = await mintToken(claims({ iss: "agent:ados-skynodepi" }), key);
    const resolver = makeResolver({ agent: { pairingKey } });
    const verified = await verifyToken(token, resolver, { expectedNodeId: "ados-skynodepi" });
    expect(verified.iss).toBe("agent:ados-skynodepi");
  });

  it("rejects when the agent subject does not match this node", async () => {
    const key = await deriveAgentTokenSecret(pairingKey);
    const token = await mintToken(claims({ iss: "agent:ados-other" }), key);
    const resolver = makeResolver({ agent: { pairingKey } });
    await expect(
      verifyToken(token, resolver, { expectedNodeId: "ados-skynodepi" }),
    ).rejects.toThrow(/does not match this node/);
  });

  it("bulk-revokes via a fresh HKDF salt (a token stops verifying)", async () => {
    const key = await deriveAgentTokenSecret(pairingKey);
    const token = await mintToken(claims({ iss: "agent:ados-skynodepi" }), key);
    const rotated = makeResolver({
      agent: { pairingKey, revocationSalt: new Uint8Array([1, 2, 3]) },
    });
    await expect(verifyToken(token, rotated)).rejects.toThrow(/signature mismatch/);
  });

  it("rejects an agent token when the server has no agent backend", async () => {
    const key = await deriveAgentTokenSecret(pairingKey);
    const token = await mintToken(claims({ iss: "agent:ados-skynodepi" }), key);
    const localOnly = makeResolver({ local: TEST_SECRET });
    await expect(verifyToken(token, localOnly)).rejects.toThrow(/agent issuer not supported/);
  });
});
