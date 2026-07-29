import pino from "pino";
export const log = pino({
  redact: { paths: ["*.apiKey", "*.authorization", "*.token", "*.secret", "*.password", "*.payload.headers.authorization"], censor: "[REDACTED]" },
});
