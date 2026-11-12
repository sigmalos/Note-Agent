/**
 * Secret redaction for logs and error messages (SRS §10.3: API keys must never be logged).
 */
const KNOWN_SECRETS = new Set<string>();

export function registerSecret(secret: string | undefined | null): void {
  if (secret && secret.length >= 6) KNOWN_SECRETS.add(secret);
}

export function clearSecrets(): void {
  KNOWN_SECRETS.clear();
}

const PATTERNS: RegExp[] = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{8,}/g,
  /((?:api[_-]?key|x-api-key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
];

export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "••••";
  return `${secret.slice(0, 3)}••••${secret.slice(-4)}`;
}

export function redact(text: string, extraSecrets: Array<string | undefined> = []): string {
  if (!text) return text;
  let out = text;
  for (const s of [...KNOWN_SECRETS, ...extraSecrets]) {
    if (s && s.length >= 6) out = out.split(s).join("[REDACTED]");
  }
  out = out.replace(PATTERNS[0], "$1[REDACTED]");
  out = out.replace(PATTERNS[1], "$1…[REDACTED]");
  out = out.replace(PATTERNS[2], "$1[REDACTED]");
  return out;
}
