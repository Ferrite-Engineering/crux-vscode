import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `vscode` is a virtual module only the real extension host provides;
// tool/test/vscode-mock.mjs stands in for it under vitest. See that file
// for what it does and does not stub.
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('../../tool/test/vscode-mock.mjs', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
