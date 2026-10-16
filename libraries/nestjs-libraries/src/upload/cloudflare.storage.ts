import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';
import 'multer';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import mime from 'mime-types';
// @ts-ignore
import { getExtension } from 'mime';
import { IUploadProvider, UploadedStream } from './upload.interface';
import axios from 'axios';
import { isSafePublicHttpsUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import { ssrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { parseDataUrl } from '@gitroom/nestjs-libraries/upload/data.url';
// file-type is ESM-only, so it is loaded on first use instead of at import time
const fileTypeFromBuffer = (buffer: Buffer): Promise<any> =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('file-type').fileTypeFromBuffer(buffer);

const ALLOWED_MIME_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
]);

class CloudflareStorage implements IUploadProvider {
  private _client: S3Client;

  constructor(
    accountID: string,
    accessKey: string,
    secretKey: string,
    private region: string,
    private _bucketName: string,
    private _uploadUrl: string
  ) {
    this._client = new S3Client({
      endpoint: `https://${accountID}.r2.cloudflarestorage.com`,
      region,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });

    this._client.middlewareStack.add(
      (next) =>
        async (args): Promise<any> => {
          const request = args.request as RequestInit;

          // Remove checksum headers
          const headers = request.headers as Record<string, string>;
          delete headers['x-amz-checksum-crc32'];
          delete headers['x-amz-checksum-crc32c'];
          delete headers['x-amz-checksum-sha1'];
          delete headers['x-amz-checksum-sha256'];
          request.headers = headers;

          Object.entries(request.headers).forEach(
            // @ts-ignore
            ([key, value]: [string, string]): void => {
              if (!request.headers) {
                request.headers = {};
              }
              (request.headers as Record<string, string>)[key] = value;
            }
          );

          return next(args);
        },
      { step: 'build', name: 'customHeaders' }
    );
  }

  async healthCheck(): Promise<void> {
    // HeadBucket valida credencial R2 + acesso ao bucket SEM escrever nada.
    await this._client.send(
      new HeadBucketCommand({ Bucket: this._bucketName })
    );
  }

  async uploadSimple(path: string) {
    const dataUrl = path.startsWith('data:') ? parseDataUrl(path) : null;

    let body: Buffer;
    if (dataUrl) {
      body = dataUrl.buffer;
    } else {
      if (!(await isSafePublicHttpsUrl(path))) {
        throw new Error('Unsafe URL');
      }
      const loadImage = await fetch(path, {
        // @ts-ignore — undici option, not in lib.dom fetch types
        dispatcher: ssrfSafeDispatcher,
      });
      body = Buffer.from(await loadImage.arrayBuffer());
    }
    const detected = await fileTypeFromBuffer(body);
    if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
      throw new Error('Unsupported file type.');
    }
    const extension = detected.ext;
    const safeContentType = detected.mime;
    const id = makeId(10);

    const params = {
      Bucket: this._bucketName,
      Key: `${id}.${extension}`,
      Body: body,
      ContentType: safeContentType,
      ChecksumMode: 'DISABLED',
    };

    const command = new PutObjectCommand({ ...params });
    await this._client.send(command);

    return `${this._uploadUrl}/${id}.${extension}`;
  }

  async uploadFile(file: Express.Multer.File): Promise<any> {
    try {
      const detected = await fileTypeFromBuffer(file.buffer);
      if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
        throw new Error('Unsupported file type.');
      }
      const id = makeId(10);
      const extension = detected.ext;
      const safeContentType = detected.mime;

      // Create the PutObjectCommand to upload the file to Cloudflare R2
      const command = new PutObjectCommand({
        Bucket: this._bucketName,
        ACL: 'public-read',
        Key: `${id}.${extension}`,
        Body: file.buffer,
        ContentType: safeContentType,
      });

      await this._client.send(command);

      return {
        filename: `${id}.${extension}`,
        mimetype: file.mimetype,
        size: file.size,
        buffer: file.buffer,
        originalname: `${id}.${extension}`,
        fieldname: 'file',
        path: `${this._uploadUrl}/${id}.${extension}`,
        destination: `${this._uploadUrl}/${id}.${extension}`,
        encoding: '7bit',
        stream: file.buffer as any,
      };
    } catch (err) {
      console.error('Error uploading file to Cloudflare R2:', err);
      throw err;
    }
  }

  async uploadStream(
    stream: Readable,
    mimetype: string,
    ext: string
  ): Promise<UploadedStream> {
    try {
      if (!ALLOWED_MIME_TYPES.has(mimetype)) {
        throw new Error('Unsupported file type.');
      }
      const id = makeId(10);
      const key = `${id}.${ext}`;

      // Multipart upload holds only a few parts in memory at a time instead
      // of the whole body, and does not need to know the length up front
      const upload = new Upload({
        client: this._client,
        params: {
          Bucket: this._bucketName,
          ACL: 'public-read',
          Key: key,
          Body: stream,
          ContentType: mimetype,
        },
      });
      await upload.done();

      return {
        filename: key,
        mimetype,
        originalname: key,
        path: `${this._uploadUrl}/${key}`,
      };
    } catch (err) {
      console.error('Error streaming file to Cloudflare R2:', err);
      throw err;
    }
  }

  async signDownloadUrl(fileName: string) {
    return getSignedUrl(
      this._client,
      new GetObjectCommand({ Bucket: this._bucketName, Key: fileName }),
      { expiresIn: 3 * 3600 }
    );
  }

  async signUploadUrl(fileName: string, contentType: string) {
    return getSignedUrl(
      this._client,
      new PutObjectCommand({
        Bucket: this._bucketName,
        Key: fileName,
        ContentType: contentType,
      }),
      { expiresIn: 3 * 3600 }
    );
  }

  publicUrl(fileName: string) {
    return `${this._uploadUrl}/${fileName}`;
  }

  async readFile(fileName: string) {
    const { Body } = await this._client.send(
      new GetObjectCommand({ Bucket: this._bucketName, Key: fileName })
    );

    return Body!.transformToString();
  }

  async writeFile(fileName: string, body: string, contentType: string) {
    await this._client.send(
      new PutObjectCommand({
        Bucket: this._bucketName,
        Key: fileName,
        Body: body,
        ContentType: contentType,
      })
    );
  }

  /**
   * Deriva a Key do objeto no bucket a partir da URL publica gravada em
   * `Media.path`/`Media.thumbnail`. Exige o prefixo `CLOUDFLARE_BUCKET_URL`:
   * uma URL de terceiro (import externo, CDN de rede social) nao pertence ao
   * nosso bucket e nao pode virar `DeleteObject`, deletariamos por engano um
   * objeto homonimo. Retorna '' quando a URL nao e nossa.
   */
  private resolveObjectKey(publicPath: string): string {
    if (!publicPath || !this._uploadUrl) {
      return '';
    }

    const clean = publicPath.split('?')[0].split('#')[0];
    const prefix = this._uploadUrl.endsWith('/')
      ? this._uploadUrl
      : `${this._uploadUrl}/`;

    // A bare key (no scheme, no slash) is how the media processor and the
    // clipping flow refer to objects of this bucket
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(clean) && !clean.includes('/')) {
      return clean;
    }

    if (!clean.startsWith(prefix)) {
      return '';
    }

    try {
      return decodeURIComponent(clean.slice(prefix.length));
    } catch {
      return clean.slice(prefix.length);
    }
  }

  // Implement the removeFile method from IUploadProvider
  async removeFile(publicPath: string): Promise<void> {
    const key = this.resolveObjectKey(publicPath);
    if (!key) {
      return;
    }

    // DeleteObject no R2/S3 e idempotente: apagar chave inexistente devolve
    // 204, entao nao ha caso de "not found" para tratar aqui.
    await this._client.send(
      new DeleteObjectCommand({
        Bucket: this._bucketName,
        Key: key,
      })
    );
  }
}

export { CloudflareStorage };
export default CloudflareStorage;
