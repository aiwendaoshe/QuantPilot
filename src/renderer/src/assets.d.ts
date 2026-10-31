/**
 * 静态图片资源的模块声明。
 *
 * tsconfig.web.json 里 `types: []`（刻意不引 vite/client，保持渲染层类型面最小），
 * 所以 `import qr from '../assets/x.jpg'` 这类由 Vite 处理的资源导入需要自带声明，
 * 否则 `vue-tsc` 会报 TS2307 找不到模块。
 *
 * 语义与 vite/client 的 asset 声明一致：默认导出构建后的 URL 字符串。
 */
declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
