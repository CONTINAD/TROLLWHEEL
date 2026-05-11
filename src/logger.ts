import { config } from "./config";

const levels = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof levels;

function should(level: Level): boolean {
  return levels[level] <= levels[(config.logLevel as Level) || "info"];
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export const logger = {
  info: (m: string) => should("info") && console.log(`[${ts()}] INFO  ${m}`),
  warn: (m: string) => should("warn") && console.warn(`[${ts()}] WARN  ${m}`),
  error: (m: string) => should("error") && console.error(`[${ts()}] ERROR ${m}`),
  debug: (m: string) => should("debug") && console.log(`[${ts()}] DEBUG ${m}`),
};
