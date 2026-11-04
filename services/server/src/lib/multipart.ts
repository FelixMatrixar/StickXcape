/** One field of a multipart/form-data body. */
export interface FormPart {
  name: string;
  filename: string | null;
  contentType: string | null;
  data: Buffer;
}

const CRLF = Buffer.from('\r\n');
const HEADERS_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_BYTES = 1024;

/** The boundary of a multipart/form-data content type, or null for any other type. */
export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType)) return null;
  const match = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(contentType);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/**
 * Splits a multipart/form-data body (RFC 7578) into its fields: what a browser sends for a
 * FormData, with CRLF line breaks, a Content-Disposition per part and an optional Content-Type.
 * Returns null for anything malformed or with more than `maxParts` parts. The body is already
 * size-capped by the route, so this works on it in memory.
 */
export function parseMultipart(body: Buffer, boundary: string, maxParts = 8): FormPart[] | null {
  const delimiter = Buffer.from(`--${boundary}`);
  const closing = Buffer.concat([CRLF, delimiter]);
  const parts: FormPart[] = [];
  let pos = body.indexOf(delimiter);
  if (pos < 0) return null;
  for (;;) {
    pos += delimiter.length;
    // After a delimiter, "--" ends the body and CRLF starts the next part.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) return parts;
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) return null;
    pos += 2;
    const headersEnd = body.indexOf(HEADERS_END, pos);
    if (headersEnd < 0 || headersEnd - pos > MAX_HEADER_BYTES) return null;
    const part = partHeaders(body.subarray(pos, headersEnd).toString('utf8'));
    if (!part) return null;
    const next = body.indexOf(closing, headersEnd + HEADERS_END.length);
    if (next < 0) return null;
    parts.push({ ...part, data: body.subarray(headersEnd + HEADERS_END.length, next) });
    if (parts.length > maxParts) return null;
    pos = next + CRLF.length;
  }
}

function partHeaders(text: string): Omit<FormPart, 'data'> | null {
  let name: string | null = null;
  let filename: string | null = null;
  let contentType: string | null = null;
  for (const line of text.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'content-disposition') {
      if (!/^form-data\s*(;|$)/i.test(value)) return null;
      name = /;\s*name="([^"]*)"/i.exec(value)?.[1] ?? null;
      filename = /;\s*filename="([^"]*)"/i.exec(value)?.[1] ?? null;
    } else if (key === 'content-type') {
      contentType = value.toLowerCase();
    }
  }
  return name === null ? null : { name, filename, contentType };
}
