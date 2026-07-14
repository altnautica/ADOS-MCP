# vendor/

Third-party or generated data bundled with the server so it works offline.

- `param-metadata/` holds the flight-controller parameter metadata floor
  (enum labels, bitmask flags, ranges, units, defaults) used to give the
  parameter tools full meaning without a network call. Populated by the read
  plane. The data is generic flight-controller metadata for the firmwares the
  platform speaks.
