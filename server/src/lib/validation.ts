import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    throw badRequest('Please correct the highlighted fields.', { fields });
  }
  return result.data;
}

/** Trims strings and converts empty strings to null. */
export const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()]).optional()
    .transform((v) => (typeof v === 'string' ? v.trim() : v))
    .transform((v) => (v === '' || v === undefined ? null : v))
    .refine((v) => v === null || v.length <= max, { message: `Must be ${max} characters or fewer` });

export const requiredText = (max: number, label = 'This field') =>
  z
    .string({ error: `${label} is required` })
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, { message: `${label} is required` })
    .refine((v) => v.length <= max, { message: `Must be ${max} characters or fewer` });

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .regex(/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i, 'Enter a valid email address');

export const optionalEmail = z
  .union([z.string(), z.null()]).optional()
  .transform((v) => (typeof v === 'string' ? v.trim() : null))
  .transform((v) => (v ? v : null))
  .pipe(z.union([z.null(), emailSchema]));

/** Canadian / North American and international (E.164-style) phone numbers. */
export function isValidPhone(value: string): boolean {
  const cleaned = value.replace(/(?:ext\.?|x)\s*\d{1,6}$/i, '').trim();
  if (!/^[+\d\s().-]+$/.test(cleaned)) return false;
  const digits = cleaned.replace(/\D/g, '');
  if (cleaned.startsWith('+')) return digits.length >= 8 && digits.length <= 15;
  if (digits.length === 10) return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits);
  if (digits.length === 11 && digits.startsWith('1')) return /^1[2-9]\d{2}[2-9]\d{6}$/.test(digits);
  return false;
}

export const optionalPhone = z
  .union([z.string(), z.null()]).optional()
  .transform((v) => (typeof v === 'string' ? v.trim() : null))
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || (v.length <= 40 && isValidPhone(v)), {
    message: 'Enter a valid phone number, e.g. 905-555-0123 or +44 20 7946 0958',
  });

export function normalizeUrl(value: string): string {
  const v = value.trim();
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

export const optionalUrl = z
  .union([z.string(), z.null()]).optional()
  .transform((v) => (typeof v === 'string' ? v.trim() : null))
  .transform((v) => (v ? normalizeUrl(v) : null))
  .refine(
    (v) => {
      if (v === null) return true;
      if (v.length > 500) return false;
      try {
        const u = new URL(v);
        return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.');
      } catch {
        return false;
      }
    },
    { message: 'Enter a valid website address, e.g. www.example.ca' },
  );

export const socialMediaSchema = z
  .array(
    z.object({
      platform: z.string().trim().max(40).default('Other'),
      handle: z.string().trim().min(1, 'Enter a handle or profile URL').max(300),
    }),
  )
  .max(10)
  .default([]);

/** Accepts "", null, "12.50", 12.5 -> number | null with two decimals. */
export const moneySchema = z
  .union([z.string(), z.number(), z.null()]).optional()
  .transform((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    const s = v.replace(/[$,\s]/g, '').replace(/CAD$/i, '');
    return s === '' ? null : Number(s);
  })
  .refine((v) => v === null || (Number.isFinite(v) && v >= 0 && v < 10_000_000_000), {
    message: 'Enter a dollar amount of 0 or more',
  })
  .transform((v) => (v === null ? null : Math.round(v * 100) / 100));

export const quantitySchema = z.coerce
  .number({ error: 'Quantity must be a whole number' })
  .int('Quantity must be a whole number')
  .min(1, 'Quantity must be at least 1')
  .max(100000);

export const dateSchema = z
  .union([z.string(), z.null()]).optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))), {
    message: 'Enter a valid date',
  });

export const CATEGORIES = ['bowls', 'food', 'auction', 'door_prize', 'other'] as const;
export const SUBCATEGORIES = ['soup', 'bread', 'dessert'] as const;
export const CATEGORY_LABELS: Record<string, string> = {
  bowls: 'Bowls',
  food: 'Food',
  auction: 'Auction',
  door_prize: 'Door Prize',
  other: 'Other',
};
export const SUBCATEGORY_LABELS: Record<string, string> = { soup: 'Soup', bread: 'Bread', dessert: 'Dessert' };

/**
 * Category/subcategory rule: SubCategory applies only to Food (and is required
 * for Food). Changing away from Food clears the subcategory.
 */
export function reconcileSubcategory(category: string, subcategory: string | null | undefined): string | null {
  if (category !== 'food') return null;
  return subcategory ?? null;
}

export const idParam = z.coerce.number().int().positive();
