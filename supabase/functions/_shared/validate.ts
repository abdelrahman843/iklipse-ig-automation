// Input validation for collect nodes. Pure functions, so they are trivial to reason about and
// test. Each returns the cleaned value to store, or null when the input does not qualify.

import type { InputType } from "./types.ts";

export interface ValidationResult {
  ok: boolean;
  value?: string | number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

export function validateInput(
  inputType: InputType,
  raw: string,
  choices: string[] = [],
): ValidationResult {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false };

  switch (inputType) {
    case "email": {
      const value = text.toLowerCase();
      return EMAIL.test(value) ? { ok: true, value } : { ok: false };
    }
    case "phone": {
      // Keep digits only. Require a country code — 10 to 15 digits is the E.164 range.
      const digits = text.replace(/[^\d]/g, "");
      return digits.length >= 10 && digits.length <= 15 ? { ok: true, value: digits } : { ok: false };
    }
    case "number":
      return NUMBER.test(text) ? { ok: true, value: Number(text) } : { ok: false };
    case "url": {
      try {
        const u = new URL(text);
        return u.protocol === "http:" || u.protocol === "https:" ? { ok: true, value: text } : { ok: false };
      } catch {
        return { ok: false };
      }
    }
    case "choice": {
      const match = choices.find((c) => c.trim().toLowerCase() === text.toLowerCase());
      return match ? { ok: true, value: match } : { ok: false };
    }
    case "text":
    default:
      return { ok: true, value: text };
  }
}
