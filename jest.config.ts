import type { Config } from 'jest';

const config: Config = {
  projects: ['<rootDir>/apps/backend', '<rootDir>/libraries/nestjs-libraries'],
  // Limita o consumo: por padrão o Jest abre (núcleos - 1) workers, ~1 GB cada.
  maxWorkers: 3,
  // Reinicia o worker quando passar desse tamanho, evitando vazamento de memória.
  workerIdleMemoryLimit: '1GB',
};

export default config;
