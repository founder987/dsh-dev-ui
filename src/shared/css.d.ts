/** esbuild loader '.css': 'text' 的配套类型声明（client 半内联注入，见 TermPanel） */
declare module '*.css' {
  const css: string;
  export default css;
}
