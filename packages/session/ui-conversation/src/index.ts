/**
 * host 半：薄壳。上游 host 入口（settings 段注册 + `submission-settings` 再导出）与我们的
 * 归一结果一致（只差注释与格式），因此不再复制源码，直接转出 vendor 源；构建时内联进
 * `dist`，发布物自包含。
 */
export * from "../../../../vendor/deepseek-harness/packages/client/ui-conversation/src/index.ts";
