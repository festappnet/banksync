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
      ? parsed.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
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
