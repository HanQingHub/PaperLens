import { defineConfig } from 'vitest/config'

// 双环境单测：
//  - node：纯函数（坐标链 / 高亮几何 / OCR / 句读 / 排序等），无 DOM 依赖
//  - jsdom：highlightDom（computeWordHighlights 需要 DOM + Range 桩），
//    真实坐标/命中断言下沉 Playwright E2E
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/__tests__/highlightDom.test.ts'],
          deps: { inline: [/react-markdown/, /remark-/, /rehype-/, /unified/, /micromark/, /mdast/, /highlight\.js/] },
        },
      },
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/__tests__/highlightDom.test.ts'],
          setupFiles: ['src/__tests__/setupJsDom.ts'],
        },
      },
    ],
  },
})
