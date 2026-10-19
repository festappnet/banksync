import { Parser } from 'htmlparser2';
import PostalMime from 'postal-mime';

export interface ExtractedEmail {
  subject: string | undefined;
  text: string;
  /** Diagnostic MIME identity only; never use as routing/auth authority. */
  fromHeader: string | undefined;
  /** Diagnostic MIME identity only; never use as routing/auth authority. */
  toHeader: string | undefined;
  messageId: string | undefined;
}

export async function extractEmailBody(
  raw: ReadableStream<Uint8Array>
): Promise<ExtractedEmail> {
  const rawString = await new Response(raw).text();
  const parsed = await PostalMime.parse(rawString);

  const text = parsed.text
    ? parsed.text
    : parsed.html
      ? htmlToText(parsed.html)
      : '';

  const fromAddr = parsed.from && 'address' in parsed.from && parsed.from.address
    ? parsed.from.address.toLowerCase()
    : undefined;

  const toFirst = parsed.to?.[0];
  const toAddr = toFirst && 'address' in toFirst && toFirst.address
    ? toFirst.address.toLowerCase()
    : undefined;

  return {
    subject: parsed.subject,
    text,
    fromHeader: fromAddr,
    toHeader: toAddr,
    messageId: parsed.messageId,
  };
}

// Parse markup as data, preserving label/value boundaries and decoding entities.
// Script/style contents cannot supply transaction fields.
function htmlToText(html: string): string {
  const text: string[] = [];
  const boundaries = new Set(['br', 'p', 'div', 'tr', 'td', 'th', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  let hidden = 0;
  const parser = new Parser({
    onopentag(name) {
      if (name === 'script' || name === 'style') hidden++;
      if (!hidden && boundaries.has(name)) text.push('\n');
    },
    ontext(value) { if (!hidden) text.push(value); },
    onclosetag(name) {
      if (name === 'script' || name === 'style') hidden = Math.max(0, hidden - 1);
      if (!hidden && boundaries.has(name)) text.push('\n');
    },
  }, { decodeEntities: true });
  parser.end(html);
  return text.join('').trim();
}
