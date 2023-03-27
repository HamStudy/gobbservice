import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/RequestResponseHelper.ts',
    'src/NatsService.ts',
    'src/LocalService.ts',
    'src/WorkerService.ts',
    'src/types.ts',
    'src/index.ts',
  ],
  tsconfig: 'tsconfig.json',
  splitting: true,
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
