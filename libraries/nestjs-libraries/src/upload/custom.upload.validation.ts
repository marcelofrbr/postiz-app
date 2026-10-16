import {
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { pipeline, Readable, Transform } from 'stream';
import { IUploadProvider } from './upload.interface';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  detectAllowedUploadMime,
} from '@gitroom/nestjs-libraries/upload/allowed.upload.mime';
// file-type is ESM-only, so it is loaded on first use instead of at import time
const fileTypeStream = (stream: ReadableStream): Promise<any> =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('file-type').fileTypeStream(stream);

// What users may put in the media library, whether by multipart upload or
// from a remote URL; narrower than what storage itself accepts, no audio
export const UPLOAD_ALLOWED_MIME = ALLOWED_UPLOAD_MIME_TYPES;

@Injectable()
export class CustomFileValidationPipe implements PipeTransform {
  async transform(value: any) {
    if (!value || typeof value !== 'object') {
      return value;
    }

    // Skip non-file parameters (org, body, query, etc.)
    if (
      !('buffer' in value) &&
      !('mimetype' in value) &&
      !('fieldname' in value)
    ) {
      return value;
    }

    if (!value.buffer || !Buffer.isBuffer(value.buffer)) {
      throw new BadRequestException('Invalid file upload.');
    }

    // Valida pelo conteudo real (magic bytes), nunca pelo mimetype declarado.
    const detected = await detectAllowedUploadMime(value.buffer);
    if (!detected) {
      throw new BadRequestException('Unsupported file type.');
    }

    const maxSize = getMaxUploadSize(detected.mime);
    if (value.size > maxSize) {
      throw new BadRequestException(
        `File size exceeds the maximum allowed size of ${maxSize} bytes.`
      );
    }

    value.mimetype = detected.mime;
    const safeBase =
      (value.originalname || 'upload')
        .replace(/\.[^./\\]*$/, '')
        .replace(/[\\/]/g, '_')
        .slice(0, 100) || 'upload';
    value.originalname = `${safeBase}.${detected.ext}`;

    return value;
  }
}

export function getMaxUploadSize(mimeType: string): number {
  if (mimeType.startsWith('image/')) {
    return 10 * 1024 * 1024; // 10 MB
  } else if (mimeType.startsWith('video/')) {
    return 1024 * 1024 * 1024; // 1 GB
  } else {
    throw new BadRequestException('Unsupported file type.');
  }
}

export const getMaxSize = getMaxUploadSize;

// Passes bytes through and fails once they exceed maxSize, so a body with a
// missing or lying Content-Length cannot be streamed into storage unbounded
export function maxSizeStream(maxSize: number) {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxSize) {
        return callback(new BadRequestException('File is too large.'));
      }
      callback(null, chunk);
    },
  });
}

// Sniffs the real type from the first bytes, applies the per-type size cap
// and streams the rest into storage, so only the sniffing prefix and a few
// upload parts are ever in memory. Rejections are BadRequestException with
// the same messages the old buffer validation used. `declaredSize` is the
// Content-Length when the sender gave one; it may be absent or wrong, so the
// stream cap is what really enforces the limit
export async function uploadStreamToStorage(
  storage: IUploadProvider,
  webStream: ReadableStream,
  declaredSize = 0
) {
  let sniffed: ReadableStream & { fileType?: { mime: string; ext: string } };
  try {
    sniffed = await fileTypeStream(webStream);
  } catch (err) {
    throw new BadRequestException('Failed to read file', { cause: err });
  }
  const detected = sniffed.fileType;
  if (!detected || !UPLOAD_ALLOWED_MIME.has(detected.mime)) {
    await sniffed.cancel();
    throw new BadRequestException('Unsupported file type.');
  }

  const maxSize = getMaxSize(detected.mime);
  if (declaredSize > maxSize) {
    await sniffed.cancel();
    throw new BadRequestException('File is too large.');
  }

  // pipeline (not pipe) so failing the cap also tears down the source
  const body = pipeline(
    Readable.fromWeb(sniffed as any),
    maxSizeStream(maxSize),
    () => {}
  );

  try {
    const uploaded = await storage.uploadStream(
      body,
      detected.mime,
      detected.ext
    );
    return { ...uploaded, ext: detected.ext };
  } catch (err) {
    // The size cap rejects mid-upload with its own BadRequestException
    body.destroy();
    throw err;
  }
}
