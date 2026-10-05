import sharp from 'sharp';
import { SVG_SANITIZE_CONFIG } from 'librechat-data-provider';
import type { MediaConfig, MediaSubmissionRequest } from 'librechat-data-provider';
import { MediaServiceError } from './errors';
import { getSvgRuntime } from '~/utils/svg';

const extensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

const mimeAliases: Record<string, string> = {
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/mp3': 'audio/mpeg',
};

export function normalizeMediaContentType(type: string): string {
  const normalized = type.split(';', 1)[0].trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(mimeAliases, normalized)
    ? mimeAliases[normalized]
    : normalized;
}

export function mediaContentExtension(type: string): string | undefined {
  const normalized = normalizeMediaContentType(type);
  return Object.prototype.hasOwnProperty.call(extensions, normalized)
    ? extensions[normalized]
    : undefined;
}

export function mediaContentByteLimit(type: string, config: MediaConfig): number {
  const normalized = normalizeMediaContentType(type);
  if (normalized.startsWith('video/')) return config.transfers.maxVideoBytes;
  if (normalized.startsWith('audio/')) return config.transfers.maxAudioBytes;
  return config.transfers.maxImageBytes;
}

type MediaInputRole = MediaSubmissionRequest['inputs'][number]['role'];

export function mediaInputByteLimit(role: MediaInputRole, config: MediaConfig): number {
  if (role === 'video') return config.transfers.maxVideoBytes;
  if (role === 'audio') return config.transfers.maxAudioBytes;
  return config.transfers.maxImageBytes;
}

/** Keep retained originals intact; providers receive a raster rendition of safe SVG references. */
export async function prepareMediaInputContent(
  role: MediaInputRole,
  type: string,
  data: Buffer,
  config: MediaConfig,
): Promise<{ type: string; data: Buffer }> {
  const normalized = normalizeMediaContentType(type);
  const kind = role === 'audio' || role === 'video' ? role : 'image';
  if (!mediaContentExtension(normalized) || !normalized.startsWith(`${kind}/`)) {
    throw new MediaServiceError(
      'unsupported',
      422,
      'The media type does not match its input role.',
    );
  }
  if (data.length > mediaInputByteLimit(role, config)) {
    throw new MediaServiceError('invalid_request', 413, 'Media input is too large.');
  }
  if (normalized !== 'image/svg+xml') return { type: normalized, data };
  validateMediaSvg(data);
  const raster = await sharp(data).png().toBuffer();
  if (raster.length > config.transfers.maxImageBytes) {
    throw new MediaServiceError('invalid_request', 413, 'The rasterized image is too large.');
  }
  return { type: 'image/png', data: raster };
}

function invalidContent(kind: string): never {
  throw new MediaServiceError('unsupported', 422, `Unsupported ${kind} content.`);
}

/** Exclude inert provider provenance from the validation DOM, never from the stored original. */
function preserveSvgProvenance(root: Element): void {
  const namespace = 'http://c2pa.org/manifest';
  const manifests = Array.from(root.getElementsByTagNameNS(namespace, '*'));
  for (const manifest of manifests) {
    const metadata = manifest.parentElement;
    if (
      manifest.localName !== 'manifest' ||
      manifest.attributes.length ||
      manifest.childElementCount ||
      metadata?.localName !== 'metadata' ||
      metadata.namespaceURI !== root.namespaceURI ||
      metadata.parentElement !== root
    ) {
      return invalidContent('SVG');
    }
    const encoded = manifest.textContent?.replace(/[\t\n\r ]/g, '') ?? '';
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      return invalidContent('SVG');
    }
    manifest.remove();
  }
  if (root.getAttribute('xmlns:c2pa') === namespace) root.removeAttribute('xmlns:c2pa');
  if (/^\s*display\s*:\s*block\s*;?\s*$/i.test(root.getAttribute('style') ?? '')) {
    root.removeAttribute('style');
  }
}

/** Reject unsafe XML rather than rewriting the original whose bytes and digest are retained. */
export function validateMediaSvg(data: Buffer): void {
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return invalidContent('SVG');
  }
  const encoding = value.match(/^\s*<\?xml\s[^?]*\bencoding\s*=\s*(['"])([^'"]+)\1/);
  if (encoding && !/^utf-?8$/i.test(encoding[2])) return invalidContent('SVG');
  const { parse, purifier } = getSvgRuntime();
  const document = parse(value);
  const root = document.documentElement;
  if (
    document.doctype ||
    root?.localName !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg'
  ) {
    return invalidContent('SVG');
  }
  const walker = document.createTreeWalker(document);
  const comments: Node[] = [];
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === node.PROCESSING_INSTRUCTION_NODE) return invalidContent('SVG');
    if (node.nodeType === node.COMMENT_NODE) comments.push(node);
    node = walker.nextNode();
  }
  for (const comment of comments) comment.parentNode?.removeChild(comment);
  preserveSvgProvenance(root);
  const before = root.outerHTML;
  purifier.sanitize(root, { ...SVG_SANITIZE_CONFIG, IN_PLACE: true });
  if (root.outerHTML !== before) return invalidContent('SVG');
}

function validateWav(data: Buffer): void {
  if (
    data.length < 44 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WAVE' ||
    data.readUInt32LE(4) + 8 !== data.length
  ) {
    return invalidContent('WAV audio');
  }
  let blockAlign = 0;
  let audioBytes = 0;
  let offset = 12;
  while (offset < data.length) {
    if (offset + 8 > data.length) return invalidContent('WAV audio');
    const tag = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > data.length) return invalidContent('WAV audio');
    if (tag === 'fmt ') {
      if (blockAlign || size < 16) return invalidContent('WAV audio');
      const format = data.readUInt16LE(start);
      const channels = data.readUInt16LE(start + 2);
      const sampleRate = data.readUInt32LE(start + 4);
      const byteRate = data.readUInt32LE(start + 8);
      const bits = data.readUInt16LE(start + 14);
      blockAlign = data.readUInt16LE(start + 12);
      if (
        ![1, 3].includes(format) ||
        !channels ||
        !sampleRate ||
        ![8, 16, 24, 32, 64].includes(bits) ||
        (format === 3 && bits !== 32 && bits !== 64) ||
        blockAlign !== (channels * bits) / 8 ||
        byteRate !== sampleRate * blockAlign
      ) {
        return invalidContent('WAV audio');
      }
    }
    if (tag === 'data') audioBytes += size;
    offset = start + size + (size % 2);
  }
  if (offset !== data.length || !blockAlign || !audioBytes || audioBytes % blockAlign) {
    return invalidContent('WAV audio');
  }
}

const mpeg1Rates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const mpeg2Rates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function validateMp3(data: Buffer): void {
  let offset = 0;
  if (data.toString('ascii', 0, 3) === 'ID3') {
    if (data.length < 10 || ![2, 3, 4].includes(data[3]) || data[4] === 255) {
      return invalidContent('MP3 audio');
    }
    let size = 0;
    for (let index = 6; index < 10; index++) {
      if (data[index] & 128) return invalidContent('MP3 audio');
      size = size * 128 + data[index];
    }
    offset = 10 + size + (data[3] === 4 && data[5] & 16 ? 10 : 0);
  }
  let frames = 0;
  let frequency = 0;
  while (offset < data.length) {
    if (offset + 128 === data.length && data.toString('ascii', offset, offset + 3) === 'TAG') {
      offset += 128;
      break;
    }
    if (offset + 4 > data.length) return invalidContent('MP3 audio');
    const version = (data[offset + 1] >> 3) & 3;
    const layer = (data[offset + 1] >> 1) & 3;
    const bitrateIndex = data[offset + 2] >> 4;
    const frequencyIndex = (data[offset + 2] >> 2) & 3;
    if (
      data[offset] !== 255 ||
      (data[offset + 1] & 224) !== 224 ||
      version === 1 ||
      layer !== 1 ||
      !bitrateIndex ||
      bitrateIndex === 15 ||
      frequencyIndex === 3 ||
      (data[offset + 3] & 3) === 2
    ) {
      return invalidContent('MP3 audio');
    }
    const sampleRate = [44100, 48000, 32000][frequencyIndex] / [4, 0, 2, 1][version];
    if (frequency && frequency !== sampleRate) return invalidContent('MP3 audio');
    frequency = sampleRate;
    const bitrate = (version === 3 ? mpeg1Rates : mpeg2Rates)[bitrateIndex];
    offset +=
      Math.floor(((version === 3 ? 144000 : 72000) * bitrate) / sampleRate) +
      ((data[offset + 2] >> 1) & 1);
    frames++;
  }
  if (offset !== data.length || frames < 2) return invalidContent('MP3 audio');
}

const oggCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index << 24;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
  }
  return value >>> 0;
});

function validateOggComments(packet: Buffer, prefix: string, vorbis: boolean): void {
  if (packet.toString('ascii', 0, prefix.length) !== prefix || packet.length < prefix.length + 8) {
    return invalidContent('Ogg audio');
  }
  let offset = prefix.length + 4 + packet.readUInt32LE(prefix.length);
  if (offset + 4 > packet.length) return invalidContent('Ogg audio');
  const count = packet.readUInt32LE(offset);
  offset += 4;
  for (let index = 0; index < count; index++) {
    if (offset + 4 > packet.length) return invalidContent('Ogg audio');
    offset += 4 + packet.readUInt32LE(offset);
  }
  if (offset > packet.length || (vorbis && packet[offset] !== 1))
    return invalidContent('Ogg audio');
}

function validateOgg(data: Buffer): void {
  let offset = 0;
  let sequence = 0;
  let serial = 0;
  let packets = 0;
  let pending: Buffer[] = [];
  let codec: 'opus' | 'vorbis' | undefined;
  let ended = false;
  while (offset < data.length) {
    if (
      ended ||
      offset + 27 > data.length ||
      data.toString('ascii', offset, offset + 4) !== 'OggS' ||
      data[offset + 4] !== 0
    ) {
      return invalidContent('Ogg audio');
    }
    const flags = data[offset + 5];
    const pageSerial = data.readUInt32LE(offset + 14);
    const pageSequence = data.readUInt32LE(offset + 18);
    const segments = data[offset + 26];
    const start = offset + 27 + segments;
    if (
      start > data.length ||
      flags > 7 ||
      pageSequence !== sequence ||
      (sequence === 0 ? !(flags & 2) : pageSerial !== serial || Boolean(flags & 2)) ||
      Boolean(flags & 1) !== pending.length > 0
    ) {
      return invalidContent('Ogg audio');
    }
    serial = pageSerial;
    sequence++;
    let end = start;
    for (let index = 0; index < segments; index++) {
      const size = data[offset + 27 + index];
      if (end + size > data.length) return invalidContent('Ogg audio');
      pending.push(data.subarray(end, end + size));
      end += size;
      if (size === 255) continue;
      const packet = Buffer.concat(pending);
      pending = [];
      if (packets === 0) {
        if (
          packet.length === 19 &&
          packet.toString('ascii', 0, 8) === 'OpusHead' &&
          packet[8] === 1 &&
          [1, 2].includes(packet[9]) &&
          packet[18] === 0
        ) {
          codec = 'opus';
        } else if (
          packet.length === 30 &&
          packet[0] === 1 &&
          packet.toString('ascii', 1, 7) === 'vorbis' &&
          packet.readUInt32LE(7) === 0 &&
          packet[11] > 0 &&
          packet.readUInt32LE(12) > 0 &&
          (packet[28] & 15) >= 6 &&
          packet[28] >> 4 <= 13 &&
          (packet[28] & 15) <= packet[28] >> 4 &&
          packet[29] === 1
        ) {
          codec = 'vorbis';
        } else {
          return invalidContent('Ogg audio');
        }
      } else if (packets === 1) {
        const prefix = codec === 'opus' ? 'OpusTags' : '\x03vorbis';
        validateOggComments(packet, prefix, codec === 'vorbis');
      } else if (codec === 'vorbis' && packets === 2) {
        if (packet.length <= 7 || packet.toString('ascii', 0, 7) !== '\x05vorbis') {
          return invalidContent('Ogg audio');
        }
      } else if (!packet.length || (codec === 'vorbis' && packet[0] & 1)) {
        return invalidContent('Ogg audio');
      }
      packets++;
    }
    let crc = 0;
    for (let index = offset; index < end; index++) {
      const value = index >= offset + 22 && index < offset + 26 ? 0 : data[index];
      crc = (crc << 8) ^ oggCrcTable[((crc >>> 24) ^ value) & 255];
    }
    if (crc >>> 0 !== data.readUInt32LE(offset + 22)) return invalidContent('Ogg audio');
    ended = Boolean(flags & 4);
    offset = end;
  }
  if (!ended || pending.length || packets < (codec === 'opus' ? 3 : 4)) {
    return invalidContent('Ogg audio');
  }
}

interface Mp4Box {
  type: string;
  data: Buffer;
}

function* eachMp4Box(data: Buffer): Generator<Mp4Box> {
  let offset = 0;
  while (offset < data.length) {
    if (offset + 8 > data.length) return invalidContent('MP4');
    let size = data.readUInt32BE(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > data.length) return invalidContent('MP4');
      const large = data.readBigUInt64BE(offset + 8);
      if (large > BigInt(data.length)) return invalidContent('MP4');
      size = Number(large);
      header = 16;
    }
    if (size === 0) size = data.length - offset;
    if (size < header || offset + size > data.length) return invalidContent('MP4');
    yield {
      type: data.toString('latin1', offset + 4, offset + 8),
      data: data.subarray(offset + header, offset + size),
    };
    offset += size;
  }
}

function mp4Boxes(data: Buffer): Mp4Box[] {
  return Array.from(eachMp4Box(data));
}

function childBox(boxes: Iterable<Mp4Box>, type: string): Buffer {
  let matching: Buffer | undefined;
  for (const box of boxes) {
    if (box.type !== type) continue;
    if (matching) return invalidContent('MP4');
    matching = box.data;
  }
  return matching ?? invalidContent('MP4');
}

function validateM4a(data: Buffer): void {
  const boxes = mp4Boxes(data);
  const ftyp = childBox(boxes, 'ftyp');
  const mdat = childBox(boxes, 'mdat');
  if (ftyp.length < 8 || !mdat.length) return invalidContent('M4A audio');
  const tracks = mp4Boxes(childBox(boxes, 'moov')).filter((box) => box.type === 'trak');
  if (!tracks.length) return invalidContent('M4A audio');
  for (const track of tracks) {
    const media = mp4Boxes(childBox(mp4Boxes(track.data), 'mdia'));
    const handler = childBox(media, 'hdlr');
    if (handler.length < 12 || handler.toString('latin1', 8, 12) !== 'soun') {
      return invalidContent('M4A audio');
    }
    const samples = mp4Boxes(childBox(mp4Boxes(childBox(media, 'minf')), 'stbl'));
    const description = childBox(samples, 'stsd');
    if (description.length < 8 || description.readUInt32BE(4) !== 1) {
      return invalidContent('M4A audio');
    }
    const entry = childBox(mp4Boxes(description.subarray(8)), 'mp4a');
    if (entry.length < 28 || !entry.readUInt16BE(16) || !entry.readUInt32BE(24)) {
      return invalidContent('M4A audio');
    }
    const sizes = childBox(samples, 'stsz');
    if (sizes.length < 12 || !sizes.readUInt32BE(8)) return invalidContent('M4A audio');
    const sampleSize = sizes.readUInt32BE(4);
    const sampleCount = sizes.readUInt32BE(8);
    if (!sampleSize && sizes.length !== 12 + sampleCount * 4) return invalidContent('M4A audio');
    let sampleBytes = sampleSize * sampleCount;
    if (!sampleSize) {
      for (let index = 0; index < sampleCount; index++)
        sampleBytes += sizes.readUInt32BE(12 + index * 4);
    }
    if (!sampleBytes || sampleBytes > mdat.length) return invalidContent('M4A audio');
  }
}

export function validateMediaAudio(data: Buffer, type: string): void {
  const normalized = normalizeMediaContentType(type);
  if (normalized === 'audio/wav') return validateWav(data);
  if (normalized === 'audio/mpeg') return validateMp3(data);
  if (normalized === 'audio/ogg') return validateOgg(data);
  if (normalized === 'audio/mp4') return validateM4a(data);
  return invalidContent('audio');
}

function validateMp4Video(data: Buffer): void {
  const ftyp = childBox(eachMp4Box(data), 'ftyp');
  if (ftyp.length < 8 || ftyp.length % 4) return invalidContent('MP4 video');
  let payload = false;
  for (const box of eachMp4Box(data)) {
    if (box.type === 'mdat' && box.data.length) payload = true;
  }
  if (!payload) return invalidContent('MP4 video');
  const movie = childBox(eachMp4Box(data), 'moov');
  let video = false;
  for (const track of eachMp4Box(movie)) {
    if (track.type !== 'trak') continue;
    const media = childBox(eachMp4Box(track.data), 'mdia');
    const handler = childBox(eachMp4Box(media), 'hdlr');
    if (handler.length < 12) return invalidContent('MP4 video');
    if (handler.toString('latin1', 8, 12) !== 'vide') continue;
    const information = childBox(eachMp4Box(media), 'minf');
    const samples = childBox(eachMp4Box(information), 'stbl');
    const description = childBox(eachMp4Box(samples), 'stsd');
    if (description.length < 8) return invalidContent('MP4 video');
    let entries = 0;
    for (const entry of eachMp4Box(description.subarray(8))) {
      if (
        !['avc1', 'avc3', 'hvc1', 'hev1', 'vp08', 'vp09', 'av01', 'mp4v'].includes(entry.type) ||
        entry.data.length < 78 ||
        !entry.data.readUInt16BE(24) ||
        !entry.data.readUInt16BE(26)
      ) {
        return invalidContent('MP4 video');
      }
      entries++;
    }
    if (!entries || entries !== description.readUInt32BE(4)) return invalidContent('MP4 video');
    video = true;
  }
  if (!video) return invalidContent('MP4 video');
}

interface EbmlElement {
  id: number;
  data: Buffer;
}

function ebmlInteger(data: Buffer): number {
  if (!data.length || data.length > 8) return invalidContent('WebM video');
  let value = 0;
  for (const byte of data) value = value * 256 + byte;
  if (!Number.isSafeInteger(value)) return invalidContent('WebM video');
  return value;
}

function ebmlVariable(data: Buffer, offset: number, identifier: boolean) {
  let width = 1;
  let marker = 128;
  while (width <= 8 && !(data[offset] & marker)) {
    width++;
    marker >>= 1;
  }
  if (width > (identifier ? 4 : 8) || offset + width > data.length) {
    return invalidContent('WebM video');
  }
  let value = BigInt(identifier ? data[offset] : data[offset] & (marker - 1));
  for (let index = 1; index < width; index++)
    value = value * BigInt(256) + BigInt(data[offset + index]);
  return {
    width,
    value,
    unknown: !identifier && value === (BigInt(1) << BigInt(width * 7)) - BigInt(1),
  };
}

function* ebmlElements(data: Buffer): Generator<EbmlElement> {
  let offset = 0;
  while (offset < data.length) {
    const identifier = ebmlVariable(data, offset, true);
    const size = ebmlVariable(data, offset + identifier.width, false);
    const id = Number(identifier.value);
    const start = offset + identifier.width + size.width;
    if (
      (size.unknown && ![0x18538067, 0x1f43b675].includes(id)) ||
      (!size.unknown && size.value > BigInt(data.length - start))
    ) {
      return invalidContent('WebM video');
    }
    const end = size.unknown ? data.length : start + Number(size.value);
    yield { id, data: data.subarray(start, end) };
    offset = end;
  }
}

function ebmlChild(data: Buffer, id: number): Buffer {
  let matching: Buffer | undefined;
  for (const element of ebmlElements(data)) {
    if (element.id !== id) continue;
    if (matching) return invalidContent('WebM video');
    matching = element.data;
  }
  return matching ?? invalidContent('WebM video');
}

function validateWebmVideo(data: Buffer): void {
  const header = ebmlChild(data, 0x1a45dfa3);
  if (ebmlChild(header, 0x4282).toString('latin1') !== 'webm') return invalidContent('WebM video');
  const segment = ebmlChild(data, 0x18538067);
  const tracks = ebmlChild(segment, 0x1654ae6b);
  const videoTracks = new Set<number>();
  for (const track of ebmlElements(tracks)) {
    if (track.id !== 0xae || ebmlInteger(ebmlChild(track.data, 0x83)) !== 1) continue;
    const codec = ebmlChild(track.data, 0x86).toString('latin1');
    const dimensions = ebmlChild(track.data, 0xe0);
    if (
      !['V_VP8', 'V_VP9', 'V_AV1'].includes(codec) ||
      !ebmlInteger(ebmlChild(dimensions, 0xb0)) ||
      !ebmlInteger(ebmlChild(dimensions, 0xba))
    ) {
      return invalidContent('WebM video');
    }
    const number = ebmlInteger(ebmlChild(track.data, 0xd7));
    if (!number) return invalidContent('WebM video');
    videoTracks.add(number);
  }
  let blocks = false;
  for (const element of ebmlElements(segment)) {
    if (element.id !== 0x1f43b675) continue;
    for (const child of ebmlElements(element.data)) {
      if (child.id !== 0xa3 && child.id !== 0xa0) continue;
      const block = child.id === 0xa3 ? child.data : ebmlChild(child.data, 0xa1);
      const track = ebmlVariable(block, 0, false);
      if (!track.value || block.length <= track.width + 3) return invalidContent('WebM video');
      if (videoTracks.has(Number(track.value))) blocks = true;
    }
  }
  if (!videoTracks.size || !blocks) return invalidContent('WebM video');
}

/** Identify a supported container from its bytes and require the selected reference modality. */
export function detectMediaReferenceType(data: Buffer, role: 'video' | 'audio'): string {
  const mp4 = data.length >= 12 && data.toString('latin1', 4, 8) === 'ftyp';
  if (role === 'video') {
    if (mp4) {
      validateMp4Video(data);
      return 'video/mp4';
    }
    if (data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3) {
      validateWebmVideo(data);
      return 'video/webm';
    }
    return invalidContent('video');
  }
  const prefix = data.toString('latin1', 0, 4);
  let type: string | undefined;
  if (mp4) type = 'audio/mp4';
  else if (prefix === 'RIFF') type = 'audio/wav';
  else if (prefix === 'OggS') type = 'audio/ogg';
  else if (prefix.startsWith('ID3') || (data[0] === 255 && (data[1] & 224) === 224))
    type = 'audio/mpeg';
  if (!type) return invalidContent('audio');
  validateMediaAudio(data, type);
  return type;
}
