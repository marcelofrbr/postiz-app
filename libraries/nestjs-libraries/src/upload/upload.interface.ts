import { Readable } from 'stream';

export interface UploadedStream {
  filename: string;
  originalname: string;
  path: string;
  mimetype: string;
}

export interface IUploadProvider {
  uploadSimple(path: string): Promise<string>;
  uploadFile(file: Express.Multer.File): Promise<any>;
  // Streams the body straight into storage without buffering it. The caller
  // has already sniffed the real type from the first bytes, so it passes the
  // detected mime/ext instead of the provider re-sniffing a buffer
  uploadStream(
    stream: Readable,
    mimetype: string,
    ext: string
  ): Promise<UploadedStream>;
  // Presigned URLs handed to the media processor, which has no storage
  // credentials; only cloud storage can mint them
  signDownloadUrl?(fileName: string): Promise<string>;
  signUploadUrl?(fileName: string, contentType: string): Promise<string>;
  // Public URL of a key the media processor wrote through a presigned upload
  publicUrl?(fileName: string): string;
  // Small text files (a transcript) exchanged with the media processor under a
  // key both sides know, where uploadSimple would pick a random one
  readFile?(fileName: string): Promise<string>;
  writeFile?(
    fileName: string,
    body: string,
    contentType: string
  ): Promise<void>;
  /**
   * Remove do storage o arquivo apontado por `publicPath` — o mesmo valor
   * gravado em `Media.path`/`Media.thumbnail` (URL pública servida ao browser),
   * NÃO um caminho de disco. Cada provider traduz a URL para a sua chave.
   *
   * Contrato:
   * - idempotente: arquivo já removido resolve sem erro;
   * - no-op silencioso quando a URL não pertence a este storage (import
   *   externo, CDN de terceiro) — nunca chuta uma chave;
   * - lança em falha real (credencial, IO), para o chamador NÃO marcar a
   *   mídia como apagada e o usuário poder tentar de novo.
   */
  removeFile(publicPath: string): Promise<void>;
  // Sonda de liveness do storage (aba Status > Saúde da infra): lança em falha
  // (credencial errada / bucket inacessível / diretório não gravável). Deve
  // validar o acesso SEM escrever um arquivo de verdade.
  healthCheck(): Promise<void>;
}
