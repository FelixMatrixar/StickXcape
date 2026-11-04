/**
 * Width and height from a JPEG's frame header, or null when the data isn't a well-formed JPEG
 * up to its first frame header. It only walks the marker segments; nothing is decoded, so a
 * huge or hostile image can be refused before any phone tries to draw it.
 */
export function jpegSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) return null;
    // A marker may be padded with extra 0xFF bytes.
    while (data[pos + 1] === 0xff && pos + 2 < data.length) pos += 1;
    const marker = data[pos + 1]!;
    pos += 2;
    // Markers that stand alone, with no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // The image ends, or its scan starts, before any frame header: not something to accept.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null;
    if (pos + 2 > data.length) return null;
    const length = (data[pos]! << 8) | data[pos + 1]!;
    if (length < 2 || pos + length > data.length) return null;
    // Start of frame: SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7) return null;
      const height = (data[pos + 3]! << 8) | data[pos + 4]!;
      const width = (data[pos + 5]! << 8) | data[pos + 6]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    pos += length;
  }
  return null;
}
