// A minimal structured logger that writes to stderr only. The stdio transport
// owns stdout for JSON-RPC frames, so every log line must go to stderr or it
// corrupts the protocol stream. Kept dependency-free on purpose.

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function threshold(): number {
  const env = (process.env.ADOS_MCP_LOG_LEVEL ?? "info").toLowerCase();
  return LEVEL_ORDER[(env as Level) in LEVEL_ORDER ? (env as Level) : "info"];
}

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold()) return;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    source: "ados-mcp",
    msg: message,
  };
  if (fields) Object.assign(line, fields);
  process.stderr.write(JSON.stringify(line) + "\n");
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
