/** Host part of an endpoint for display, tolerant of missing scheme or bad input. */
export function hostOf(endpoint: string): string {
  try {
    return new URL(/^https?:/i.test(endpoint) ? endpoint : `https://${endpoint}`).host;
  } catch {
    return endpoint || "（未填写 Endpoint）";
  }
}
