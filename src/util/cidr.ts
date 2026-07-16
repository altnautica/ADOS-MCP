// Minimal source-IP CIDR matching for the token's sourceIpCidr pin. Loopback is
// always allowed. An empty pin list means no restriction. Supports IPv4 CIDR and
// exact IPv6; a malformed entry never matches (fail closed for that entry).

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopback(ip: string): boolean {
  return LOOPBACK.has(ip) || ip.startsWith("127.");
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255 || !/^\d+$/.test(p)) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function matchIpv4Cidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  if (base === undefined) return false;
  // A trailing slash with no mask ("x.x.x.x/") is malformed; it must NOT parse
  // to /0 (which would match every address and silently disable the pin).
  if (bitsStr !== undefined && bitsStr.trim() === "") return false;
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// Private / mDNS / loopback ranges — "the LAN". Mirrors the GCS SSRF whitelist
// (ADOSMissionControl/src/lib/agent/host-validation.ts) so the connector's on-box
// trust boundary and the GCS proxy agree on what counts as a local target.
const PRIVATE_V4 = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^127\./,
  /^169\.254\./, // link-local
];

/**
 * True when a target host points at a private / mDNS / loopback address — the LAN,
 * where local presence is the credential and the drone's own pairing key authorizes
 * the data path. A public/routable host returns false (so it still requires a token).
 * Accepts a bare host, a `host:port` pair, or an `http://host:port/…` URL. Fails
 * closed: an unparseable input returns false.
 */
export function isPrivateOrLocalHost(input: string): boolean {
  let s = (input ?? "").trim().toLowerCase();
  if (!s) return true; // empty == the default localhost target
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme
  s = s.replace(/[/?#].*$/, ""); // strip path / query / fragment
  let host = s;
  if (host.startsWith("[")) {
    // bracketed IPv6 literal: [::1] or [::1]:8080
    const end = host.indexOf("]");
    host = end >= 0 ? host.slice(1, end) : host.slice(1);
  } else if ((host.match(/:/g) || []).length === 1) {
    host = host.slice(0, host.lastIndexOf(":")); // host:port (IPv4 / hostname)
  }
  // (2+ colons and no brackets → a bare IPv6 literal; leave it intact)
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  if (host.endsWith(".local")) return true;
  if (PRIVATE_V4.some((re) => re.test(host))) return true;
  // IPv6 ULA (fc00::/7) + link-local (fe80::/10)
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  return false;
}

/** True when `ip` is permitted by the CIDR list (loopback always allowed). */
export function sourceIpAllowed(cidrs: readonly string[], ip: string | undefined): boolean {
  if (!ip) return true; // no source info (e.g. stdio / on-box); not the place to reject
  if (isLoopback(ip)) return true;
  if (cidrs.length === 0) return true;
  const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  for (const cidr of cidrs) {
    if (cidr.includes(".")) {
      if (matchIpv4Cidr(normalized, cidr)) return true;
    } else if (cidr === ip || cidr === normalized) {
      return true; // exact IPv6 match
    }
  }
  return false;
}
