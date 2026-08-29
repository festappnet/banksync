function mod97(numeric: string): number {
  let remainder = 0;
  for (let index = 0; index < numeric.length; index += 7) {
    remainder = Number(String(remainder) + numeric.slice(index, index + 7)) % 97;
  }
  return remainder;
}

function toNumeric(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code >= 48 && code <= 57) output += character;
    else if (code >= 65 && code <= 90) output += String(code - 55);
    else return "";
  }
  return output;
}

/** Encode an alphanumeric payload as an ISO 11649 creditor reference. */
export function encodeRf(input: string): string {
  const payload = input.trim().toUpperCase();
  const numeric = toNumeric(payload + "RF00");
  if (!numeric) throw new TypeError("ISO 11649 payload must be alphanumeric");
  const checkDigits = 98 - mod97(numeric);
  return "RF" + String(checkDigits).padStart(2, "0") + payload;
}

/** Validate an ISO 11649 creditor reference and return its payload. */
export function decodeRf(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const reference = input.replace(/\s+/g, "").toUpperCase();
  if (!/^RF\d{2}[0-9A-Z]+$/.test(reference)) return null;
  const numeric = toNumeric(reference.slice(4) + reference.slice(0, 4));
  if (!numeric || mod97(numeric) !== 1) return null;
  return reference.slice(4);
}
