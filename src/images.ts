import { zlibSync } from 'fflate';

export interface ExtractedImage {
  name: string; bytes: Uint8Array; mime: string; label: string;
  role?: 'body' | 'header' | 'footer' | 'note';
}
export function imageType(bytes: Uint8Array): { extension: string; mime: string } | undefined {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: 'png', mime: 'image/png' };
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return { extension: 'jpg', mime: 'image/jpeg' };
  if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString())) return { extension: 'gif', mime: 'image/gif' };
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { extension: 'webp', mime: 'image/webp' };
}

// PDF.js supplies decoded pixels. Encode a standard PNG using the existing JS
// zlib dependency; no canvas, native module or external executable is needed.
export function png(width: number, height: number, data: Uint8Array | Uint8ClampedArray, kind: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16_000_000) throw new Error('图片超过 1600 万像素上限');
  const channels = kind === 3 ? 4 : kind === 2 ? 3 : kind === 1 ? 1 : 0;
  const stride = kind === 1 ? Math.ceil(width / 8) : width * channels;
  if (!channels || data.length !== stride * height) throw new Error('图片像素格式不受支持');
  const rows = new Uint8Array((width * channels + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (width * channels + 1) + 1;
    if (kind === 1) {
      for (let x = 0; x < width; x++) rows[start + x] = (data[y * stride + (x >> 3)] & (128 >> (x & 7))) ? 255 : 0;
    } else rows.set(data.subarray(y * stride, (y + 1) * stride), start);
  }
  function chunk(type: string, content: Uint8Array) {
    const out = Buffer.alloc(content.length + 12);
    out.writeUInt32BE(content.length); out.write(type, 4); out.set(content, 8);
    let crc = 0xffffffff;
    for (const value of out.subarray(4, -4)) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 4 ? 6 : channels === 3 ? 2 : 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(rows)), chunk('IEND', new Uint8Array())]);
}
