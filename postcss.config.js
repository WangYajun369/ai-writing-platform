// PostCSS 配置文件
// 用于定义 CSS 后处理插件链，对 CSS 进行转换和优化
export default {
  plugins: {
    // Tailwind CSS 插件：扫描源文件中的工具类，生成对应的实用 CSS
    tailwindcss: {},
    // Autoprefixer 插件：自动为 CSS 属性添加浏览器厂商前缀，提升兼容性
    autoprefixer: {},
  },
}
