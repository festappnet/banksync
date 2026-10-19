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

// Keep bank label/value boundaries in HTML-only notifications. Decode entities
// after stripping markup so escaped text never becomes executable markup.
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>|<\/(?:p|div|tr|td|th|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|[0-9]+);/gi, entity => {
      const named: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      const key = entity.toLowerCase();
      if (named[key]) return named[key]!;
      const numeric = key.slice(2, -1);
      const point = numeric.startsWith('x') ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '\ufffd';
    })
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}
