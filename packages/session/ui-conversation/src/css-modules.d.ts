/**
 * vendor 侧的 client 组件直接 `import css from "./X.module.css"`（上游构建靠 bundler
 * 解析）。薄壳形态下这些文件进了我们的 TS program 与声明图，这里补 ambient 声明把它们
 * 定成「有一个 class 映射的模块」。
 */
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
