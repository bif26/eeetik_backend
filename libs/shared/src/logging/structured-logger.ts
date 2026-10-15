import { appendFile, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type StructuredLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StructuredLogPayload {
  requestId?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
  uniqueId?: string;
  jobId?: string;
  [key: string]: unknown;
}

const LOG_LEVEL_ORDER: Record<StructuredLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const loggerCache = new Map<string, StructuredLogger>();

function parseLogLevel(level: string | undefined): StructuredLogLevel {
  const normalized = level?.toLowerCase();
  if (
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
  ) {
    return normalized;
  }

  return 'info';
}

export class StructuredLogger {
  private readonly minLevel: StructuredLogLevel;
  private readonly logFilePath: string;
  private fileLoggingEnabled = true;

  constructor(private readonly service: string) {
    this.minLevel = parseLogLevel(process.env.LOG_LEVEL);
    const configuredLogDir = process.env.LOG_DIR?.trim() || '.local/logs';
    const resolvedLogDir = resolve(process.cwd(), configuredLogDir);
    this.logFilePath = join(resolvedLogDir, 'operations.log');

    try {
      mkdirSync(resolvedLogDir, { recursive: true });
    } catch (error) {
      this.fileLoggingEnabled = false;
      this.emitConsoleLine(
        'warn',
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'warn',
          service: this.service,
          event: 'logging.directory_unavailable',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to initialize log directory',
          logDir: resolvedLogDir,
        }),
      );
    }
  }

  debug(event: string, payload: StructuredLogPayload = {}): void {
    this.write('debug', event, payload);
  }

  info(event: string, payload: StructuredLogPayload = {}): void {
    this.write('info', event, payload);
  }

  warn(event: string, payload: StructuredLogPayload = {}): void {
    this.write('warn', event, payload);
  }

  error(event: string, payload: StructuredLogPayload = {}): void {
    this.write('error', event, payload);
  }

  private write(
    level: StructuredLogLevel,
    event: string,
    payload: StructuredLogPayload,
  ): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      event,
      ...payload,
    };
    const line = JSON.stringify(entry);

    this.emitConsoleLine(level, line);

    if (!this.fileLoggingEnabled) {
      return;
    }

    appendFile(this.logFilePath, `${line}\n`, (error) => {
      if (!error) {
        return;
      }

      this.fileLoggingEnabled = false;
      this.emitConsoleLine(
        'warn',
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'warn',
          service: this.service,
          event: 'logging.file_write_failed',
          message: error.message,
          logFilePath: this.logFilePath,
        }),
      );
    });
  }

  private emitConsoleLine(level: StructuredLogLevel, line: string): void {
    if (level === 'error') {
      console.error(line);
      return;
    }

    if (level === 'warn') {
      console.warn(line);
      return;
    }

    console.log(line);
  }
}

export function getStructuredLogger(service: string): StructuredLogger {
  const cachedLogger = loggerCache.get(service);
  if (cachedLogger) {
    return cachedLogger;
  }

  const logger = new StructuredLogger(service);
  loggerCache.set(service, logger);
  return logger;
}
