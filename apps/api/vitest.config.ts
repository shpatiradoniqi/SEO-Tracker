import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));

export default defineConfig({ test: { fileParallelism: false } });
