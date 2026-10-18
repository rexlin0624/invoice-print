import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 外壳桥（shell/save/libraryBackup）是纯逻辑，不碰 DOM —— node 环境足够。
    // 真需要测渲染时再引 jsdom，不要为了习惯先背上它。
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
