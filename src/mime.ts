import PostalMime from 'postal-mime';

export interface ExtractedEmail {
  subject: string | undefined;
  text: string;
  from: string | undefined;
  to: string | undefined;
  messageId: string | undefined;
  authResults: string | undefined;
  dkimPass: boolean;
  dkimDomain: string | undefined;
  dmarcPass: boolean;
  isAligned: boolean;
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

  const authResults = parsed.headers
    .find((h) => h.key === 'authentication-results')
    ?.value;

  const dkimPass = authResults ? /dkim=pass/i.test(authResults) : false;

  let dkimDomain: string | undefined;
  if (dkimPass && authResults) {
    const match = /dkim=pass[^;]*?\bheader\.d=([^\s;]+)/i.exec(authResults);
    if (match?.[1]) {
      dkimDomain = match[1].toLowerCase();
    }
  }

  const dmarcPass = authResults ? /dmarc=pass/i.test(authResults) : false;

  let isAligned = false;
  if (dmarcPass) {
    isAligned = true;
  } else if (dkimPass && dkimDomain !== undefined && fromAddr !== undefined) {
    const atIdx = fromAddr.indexOf('@');
    const fromDomain = atIdx >= 0 ? fromAddr.slice(atIdx + 1) : fromAddr;
    isAligned =
      fromDomain === dkimDomain ||
      fromDomain.endsWith('.' + dkimDomain);
  }

  return {
    subject: parsed.subject,
    text,
    from: fromAddr,
    to: toAddr,
    messageId: parsed.messageId,
    authResults,
    dkimPass,
    dkimDomain,
    dmarcPass,
    isAligned,
  };
}
