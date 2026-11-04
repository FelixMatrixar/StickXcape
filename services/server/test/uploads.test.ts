import { describe, expect, it } from 'vitest';
import { jpegSize } from '../src/lib/jpeg.ts';
import { multipartBoundary, parseMultipart } from '../src/lib/multipart.ts';

/** A multipart body exactly as fetch serializes a FormData, with its content type. */
async function formBody(form: FormData): Promise<{ body: Buffer; contentType: string }> {
  const response = new Response(form);
  return { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type')! };
}

describe('multipart forms', () => {
  it('reads the fields a FormData sends, binary files included', async () => {
    const form = new FormData();
    form.append('file', new Blob(['{"a":1}'], { type: 'application/json' }), 'arena.json');
    const bytes = new Uint8Array([0, 13, 10, 45, 45, 255]);
    form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'arena.jpg');
    form.append('palette', 'plain "text"');
    const { body, contentType } = await formBody(form);
    const boundary = multipartBoundary(contentType)!;
    const parts = parseMultipart(body, boundary)!;
    expect(parts.map(({ name, filename, contentType: type }) => [name, filename, type])).toEqual([
      ['file', 'arena.json', 'application/json'],
      ['image', 'arena.jpg', 'image/jpeg'],
      ['palette', null, null],
    ]);
    expect(parts[0]!.data.toString()).toBe('{"a":1}');
    expect(new Uint8Array(parts[1]!.data)).toEqual(bytes);
    expect(parts[2]!.data.toString()).toBe('plain "text"');
  });

  it('finds the boundary only in a multipart/form-data type', () => {
    expect(multipartBoundary('multipart/form-data; boundary=----abc123')).toBe('----abc123');
    expect(multipartBoundary('multipart/form-data; charset=utf-8; boundary="quoted value"')).toBe('quoted value');
    expect(multipartBoundary('application/json')).toBeNull();
    expect(multipartBoundary('multipart/form-data')).toBeNull();
    expect(multipartBoundary(undefined)).toBeNull();
  });

  it('refuses bodies that are cut short, unnamed, or have too many parts', async () => {
    const one = (headers: string, rest = 'value\r\n--b--\r\n') => Buffer.from(`--b\r\n${headers}\r\n\r\n${rest}`);
    expect(parseMultipart(one('Content-Disposition: form-data; name="x"'), 'b')).toHaveLength(1);
    expect(parseMultipart(one('Content-Disposition: form-data; name="x"', 'value'), 'b')).toBeNull();
    expect(parseMultipart(one('Content-Disposition: form-data'), 'b')).toBeNull();
    expect(parseMultipart(one('Content-Disposition: attachment; name="x"'), 'b')).toBeNull();
    expect(parseMultipart(one(`Content-Disposition: form-data; name="x"\r\nX-Long: ${'a'.repeat(1100)}`), 'b')).toBeNull();
    expect(parseMultipart(Buffer.from('no boundary here'), 'b')).toBeNull();

    const form = new FormData();
    for (let i = 0; i < 9; i++) form.append(`f${i}`, 'x');
    const { body, contentType } = await formBody(form);
    expect(parseMultipart(body, multipartBoundary(contentType)!)).toBeNull();
    expect(parseMultipart(body, multipartBoundary(contentType)!, 9)).toHaveLength(9);
  });
});

describe('JPEG size', () => {
  const frame = (marker: number, width: number, height: number) => [0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];

  it('reads the frame header after other segments, for baseline and progressive JPEGs', () => {
    expect(jpegSize(new Uint8Array([0xff, 0xd8, ...app0, ...frame(0xc0, 1280, 720)]))).toEqual({ width: 1280, height: 720 });
    expect(jpegSize(new Uint8Array([0xff, 0xd8, ...frame(0xc2, 640, 480)]))).toEqual({ width: 640, height: 480 });
    // Padding 0xFF bytes before a marker are allowed.
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xff, ...app0.slice(1), ...frame(0xc0, 32, 16)]))).toEqual({ width: 32, height: 16 });
  });

  it('refuses anything that is not a JPEG up to its frame header', () => {
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegSize(new Uint8Array([0xff, 0xd8, ...app0]))).toBeNull(); // ends before a frame
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]))).toBeNull(); // a scan before any frame
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x7f, 0xff, 0x00]))).toBeNull(); // a length past the end
    expect(jpegSize(new Uint8Array([0xff, 0xd8, ...frame(0xc4, 1, 1)]))).toBeNull(); // DHT is not a frame
    expect(jpegSize(new Uint8Array([0xff, 0xd8, ...frame(0xc0, 0, 720)]))).toBeNull();
  });
});
