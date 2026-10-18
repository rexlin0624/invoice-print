import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // 样本回归：解析真实文件，单测超时给宽一点
    testTimeout: 30_000,
  },
});
