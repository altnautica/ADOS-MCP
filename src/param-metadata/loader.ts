// Loads the vendored flight-controller parameter-metadata floor and joins it
// against a live parameter blob so a parameter reads with meaning (enum label,
// bitmask flags, range, unit, default) instead of a bare number. The snapshots
// are gzipped JSON generated from firmware sources; a missing or malformed
// snapshot degrades to an empty map rather than throwing.

import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { logger } from "../util/logger.js";

export type FirmwareType = "ardupilot" | "px4" | "betaflight" | "inav" | "unknown";
export type VehicleClass = "copter" | "plane" | "rover" | "sub";

export interface FirmwareRef {
  firmware: FirmwareType;
  vehicleClass?: VehicleClass;
}

export interface ParamMetadata {
  name: string;
  humanName?: string;
  description?: string;
  range?: { min: number; max: number };
  units?: string;
  values?: [number, string][];
  bitmask?: [number, string][];
  bitmaskDescriptions?: [number, string][];
  increment?: number;
  defaultValue?: number;
  rebootRequired?: boolean;
  advanced?: boolean;
  readOnly?: boolean;
  volatile?: boolean;
  calibration?: boolean;
  vector3?: boolean;
  valueType?: string;
  category?: string;
  group?: string;
  decimalPlaces?: number;
}

interface ParamSnapshot {
  provenance?: { firmware?: string; version?: string; paramCount?: number };
  params?: ParamMetadata[];
}

export interface DecodedParam {
  name: string;
  value: number | string | boolean;
  decoded?: string;
  metadata?: ParamMetadata;
}

const cache = new Map<string, Map<string, ParamMetadata>>();

function basenamesFor(ref: FirmwareRef): string[] {
  switch (ref.firmware) {
    case "ardupilot":
      return [`ardupilot-${ref.vehicleClass ?? "copter"}`];
    case "px4":
      return ["px4"];
    case "inav":
      return ["inav"];
    case "betaflight":
      // The bf-settings snapshot carries the real parameters; the base file is a stub.
      return ["bf-settings-2026.6", "betaflight"];
    default:
      return [];
  }
}

function vendorPath(basename: string): string {
  return fileURLToPath(new URL(`../../vendor/param-metadata/${basename}.json.gz`, import.meta.url));
}

async function loadSnapshot(basename: string): Promise<ParamMetadata[]> {
  try {
    const gz = await readFile(vendorPath(basename));
    const json = gunzipSync(gz).toString("utf8");
    const snap = JSON.parse(json) as ParamSnapshot;
    return Array.isArray(snap.params) ? snap.params : [];
  } catch (err) {
    logger.debug(`param-metadata snapshot missing: ${basename}`, { err: String(err) });
    return [];
  }
}

/** Load (and cache) the parameter-metadata map for a firmware, keyed by name. */
export async function loadParamMetadata(ref: FirmwareRef): Promise<Map<string, ParamMetadata>> {
  const key = `${ref.firmware}:${ref.vehicleClass ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const map = new Map<string, ParamMetadata>();
  // Load base files first, then overlay the more-specific ones (order matters
  // for betaflight, where bf-settings overrides the stub).
  const names = basenamesFor(ref).reverse();
  for (const basename of names) {
    for (const meta of await loadSnapshot(basename)) {
      if (meta && typeof meta.name === "string") map.set(meta.name, meta);
    }
  }
  cache.set(key, map);
  return map;
}

/** Decode a numeric value into its enum label or bitmask flag list, if known. */
export function decodeValue(meta: ParamMetadata | undefined, value: unknown): string | undefined {
  if (!meta || typeof value !== "number") return undefined;
  if (meta.values && meta.values.length > 0) {
    // Enum: an exact code match.
    const hit = meta.values.find(([code]) => code === value);
    if (hit) return hit[1];
  }
  if (meta.bitmask && meta.bitmask.length > 0) {
    const flags: string[] = [];
    for (const [bit, label] of meta.bitmask) {
      if ((value & (1 << bit)) !== 0) flags.push(label);
    }
    return flags.length > 0 ? flags.join(", ") : "(no bits set)";
  }
  return undefined;
}

/** Join a live {name: value} parameter map against the metadata registry. */
export function joinParams(
  params: Record<string, number | string | boolean>,
  meta: Map<string, ParamMetadata>,
  prefix?: string,
): DecodedParam[] {
  const out: DecodedParam[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (prefix && !name.startsWith(prefix)) continue;
    const m = meta.get(name);
    const decoded = decodeValue(m, value);
    out.push({
      name,
      value,
      ...(decoded !== undefined ? { decoded } : {}),
      ...(m ? { metadata: m } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Which parameters differ from their firmware default. */
export function paramsDifferingFromDefault(
  params: Record<string, number | string | boolean>,
  meta: Map<string, ParamMetadata>,
): DecodedParam[] {
  const out: DecodedParam[] = [];
  for (const [name, value] of Object.entries(params)) {
    const m = meta.get(name);
    if (m?.defaultValue === undefined) continue;
    if (typeof value === "number" && value !== m.defaultValue) {
      out.push({ name, value, ...(decodeValue(m, value) !== undefined ? { decoded: decodeValue(m, value)! } : {}), metadata: m });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
