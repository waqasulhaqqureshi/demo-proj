import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

// Accepts "+92 300 123 4567"-style input; returns { e164, country } or null.
export function parsePhone(input) {
  const parsed = parsePhoneNumberFromString(String(input || '').trim());
  if (!parsed || !parsed.isValid()) return null;
  return { e164: parsed.number, country: parsed.country || null };
}
