// OCR 叠加层：逐行绝对定位渲染（与 pdf.js 文本层同构方案）。
// 每条 OCR line → 独立 .ocr-line span，按 line.bbox 绝对定位 + 实测校准字号，
// 替代旧版"整块单 span 浏览器流式换行"（换行边界与 OCR 检测行界不一致 → 错位）。
import { memo } from 'react'
import { bboxToCss, type PageGeom } from '../../shared/coords'
import type { OcrPageBlocks } from '../../api/types'
import { OCR_LINE_HEIGHT_RATIO, OCR_LINE_FONT_FLOOR } from './constants'

type Block = OcrPageBlocks['blocks'][number]
type Line = NonNullable<Block['lines']>[number]

/** OCR 行 bbox（PDF pt）→ 页内 CSS 定位（纯函数，复用 pdfRectToCss 语义） */
export function ocrLineCss(line: Line, geom: PageGeom) {
  return bboxToCss(line.bbox, geom)
}

/** OCR 行框高 → 字号：行高 × 实测校准系数，保底 行高 × OCR_LINE_FONT_FLOOR（防异常碎框） */
export function ocrLineFontSize(line: Line, geom: PageGeom): number {
  const h = (line.bbox[3] - line.bbox[1]) * geom.scale
  return Math.max(h * OCR_LINE_FONT_FLOOR, h * OCR_LINE_HEIGHT_RATIO)
}

/** 旧数据防御：无 lines 字段的 block 退回块级单 span（流式换行，历史行为） */
function FallbackBlockSpan({ block, geom }: { block: Block; geom: PageGeom }) {
  const css = bboxToCss(block.bbox, geom)
  const h = css.height
  const fontSize = Math.max(h * OCR_LINE_FONT_FLOOR, h * OCR_LINE_HEIGHT_RATIO)
  return (
    <span
      className="ocr-block"
      style={{ left: css.left, top: css.top, width: css.width, height: css.height, fontSize }}
    >
      {block.text}
    </span>
  )
}

/** OCR 叠加层：blocks → 逐行 span（行尾补空格，跨行划选 toString 不粘连） */
export const OcrOverlay = memo(function OcrOverlay({
  blocks,
  geom,
}: {
  blocks: Block[]
  geom: PageGeom
}) {
  return (
    <>
      {blocks.map((block, i) => {
        if (!block.lines?.length) return <FallbackBlockSpan key={i} block={block} geom={geom} />
        return block.lines.map((line, j) => {
          const css = ocrLineCss(line, geom)
          return (
            <span
              key={`${i}-${j}`}
              className="ocr-line"
              style={{
                left: css.left,
                top: css.top,
                fontSize: ocrLineFontSize(line, geom),
              }}
            >
              {line.text + ' '}
            </span>
          )
        })
      })}
    </>
  )
})
