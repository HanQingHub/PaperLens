import { defineConfig } from 'vitest/config'

// 仅纯函数单测（坐标链 / OCR 叠加），node 环境无 DOM 依赖；
// 独立于 vite.config.ts（不加载 react/tailwind 插件）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    deps: { inline: [/react-markdown/, /remark-/, /rehype-/, /unified/, /micromark/, /mdast/, /highlight\.js/] },
  },
})
