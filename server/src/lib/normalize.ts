/** Normalization helpers for duplicate-donor detection. */

const BUSINESS_SUFFIXES = /\b(inc|incorporated|ltd|limited|llc|llp|corp|corporation|co|company|the|ltee|enr)\b/g;

export function normalizeName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(BUSINESS_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n || null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return email.trim().toLowerCase() || null;
}

/** Digits only; North American numbers are reduced to their 10-digit form. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const withoutExt = phone.replace(/(?:ext\.?|x)\s*\d{1,6}$/i, '');
  let digits = withoutExt.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length >= 7 ? digits : null;
}
