/** Host part of an endpoint for display, tolerant of missing scheme or bad input. */
export function hostOf(endpoint: string): string {
  try {
    return new URL(/^https?:/i.test(endpoint) ? endpoint : `https://${endpoint}`).host;
  } catch {
    return endpoint || "（未填写 Endpoint）";
  }
}

/**
 * Short service name derived from an endpoint, e.g. https://llmapi.paratera.com → "Paratera",
 * http://localhost:11434/v1 → "localhost".
 */
export function serviceNameOf(endpoint: string): string {
  let host = "";
  try {
    host = new URL(/^https?:/i.test(endpoint) ? endpoint : `https://${endpoint}`).hostname;
  } catch {
    return "";
  }
  if (!host || /^[\d.]+$/.test(host) || !host.includes(".")) return host;
  const parts = host.split(".");
  // Skip second-level suffixes such as .com.cn / .co.uk.
  let i = parts.length - 2;
  if (i > 0 && /^(com|net|org|co|ac|gov|edu)$/.test(parts[i])) i--;
  const name = parts[i];
  return name.charAt(0).toUpperCase() + name.slice(1);
}
