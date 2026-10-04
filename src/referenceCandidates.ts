import { decodeRf } from './iso11649.js';

/** Legacy v1 compatibility utilities. Canonical v2 bank facts do not infer order identifiers.
 * Consumers own payment identification and their business rules. */

export interface ReferenceSource {
  vs?: string | null;
  ss?: string | null;
  message?: string | null;
  user_identification?: string | null;
  comment?: string | null;
}

const MAX_CANDIDATES = 5;

function normalizeText(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

function validVs(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return /^\d{1,10}$/.test(normalized) ? normalized : null;
}

function rfCores(text: string): string[] {
  const compact = normalizeText(text).replace(/\s+/g, '');
  const cores: string[] = [];
  for (const match of compact.matchAll(/RF\d{3,12}(?!\d)/g)) {
    const decoded = decodeRf(match[0]);
    if (decoded && /^\d{1,10}$/.test(decoded) && !cores.includes(decoded)) {
      cores.push(decoded);
    }
  }
  return cores;
}

/**
 * Legacy v1 projection value. A real structured VS
 * wins. Otherwise only a checksum-valid RF carrying a 1-10 digit VS may fill
 * the field; labelled/bare free-text candidates remain resolver hints and are
 * never promoted into stored structured data.
 */
export function resolveVariableSymbol(src: ReferenceSource): string | null {
  const structured = validVs(src.vs);
  if (structured) return structured;

  for (const text of [src.vs, src.message, src.ss, src.user_identification, src.comment]) {
    if (typeof text !== 'string') continue;
    const [decoded] = rfCores(text);
    if (decoded) return decoded;
  }
  return null;
}

export function extractReferenceCandidates(src: ReferenceSource): string[] {
  const out: string[] = [];
  const push = (v: string | null | undefined) => {
    if (!v) return;
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  };

  // 1. structured VS field — highest confidence, first.
  push(validVs(src.vs) ?? undefined);

  const texts = [src.message, src.ss, src.user_identification, src.comment]
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .map(normalizeText);

  // 2. labelled VS + RF references (structured carriers) before bare runs, so
  //    the ≤5 cap keeps the high-confidence candidates.
  for (const t of texts) {
    const compact = t.replace(/\s+/g, "");
    for (const m of compact.matchAll(/VS[:/]?(\d{4,10})/g)) push(m[1]);
    for (const core of rfCores(t)) push(core);
  }
  // 3. bare VS-shaped digit runs.
  for (const t of texts) {
    for (const m of t.matchAll(/(?<!\d)(\d{6,10})(?!\d)/g)) push(m[1]);
  }

  return out.slice(0, MAX_CANDIDATES);
}
