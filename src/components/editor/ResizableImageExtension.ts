/**
 * ResizableImageExtension — 可缩放图片扩展
 *
 * 基于 @tiptap/extension-image 扩展 width 属性，
 * 并注册 React NodeView 渲染缩放控件。
 */
import Image from '@tiptap/extension-image'
import { ReactNodeViewRenderer } from '@tiptap/react'
import ImageResizeNodeView from './ImageResizeNodeView'

export const ResizableImage = Image.extend({
  name: 'resizableImage',

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: '100%',
        parseHTML: (element) => {
          const dataWidth = element.getAttribute('data-width')
          if (dataWidth) return dataWidth
          const styleWidth = element.style.width
          if (styleWidth && /^\d+%$/.test(styleWidth)) return styleWidth
          return '100%'
        },
        renderHTML: ({ width }) => {
          if (width === '100%') return {}
          return { 'data-width': width, style: `width: ${width}` }
        },
      },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageResizeNodeView)
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          if (typeof dom === 'string') return {}
          const element = dom as HTMLElement
          return {
            src: element.getAttribute('src') ?? '',
            alt: element.getAttribute('alt') ?? null,
            title: element.getAttribute('title') ?? null,
          }
        },
      },
    ]
  },
})
