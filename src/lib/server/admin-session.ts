export const COOKIE = 'cfb-admin-session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
