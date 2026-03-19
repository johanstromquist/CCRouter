type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function formatData(data?: Record<string, unknown>): string {
  if (!data || Object.keys(data).length === 0) return "";
  return " " + JSON.stringify(data);
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

export interface Logger {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

export function createLogger(context: string): Logger {
  function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!shouldLog(level)) return;
    const line = `[${formatTimestamp()}] [${level}] [${context}] ${message}${formatData(data)}`;
    process.stderr.write(line + "\n");
  }

  return {
    debug: (message, data) => log("debug", message, data),
    info: (message, data) => log("info", message, data),
    warn: (message, data) => log("warn", message, data),
    error: (message, data) => log("error", message, data),
  };
}
