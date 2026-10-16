// Stub do file-type (ESM-only) para o jest/ts-jest, que transforma so .tsx?.
// Specs que exercitam a deteccao real mockam o modulo explicitamente
// (jest.mock('file-type', ...)); o carregamento real e coberto por
// allowed.upload.mime.spec.ts em um processo filho.
const fileTypeFromBuffer = async () => undefined;
module.exports = { fileTypeFromBuffer };
