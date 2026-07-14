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
