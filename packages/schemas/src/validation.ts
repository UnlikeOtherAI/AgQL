import type { z } from 'zod';

import {
  type ValidationResult,
  structuralErrors,
} from './errors.ts';

export function validateDocument<Output, Input>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  value: unknown,
): ValidationResult<Output> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, errors: structuralErrors(result.error) };
}
