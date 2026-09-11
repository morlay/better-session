// wire 编解码层：请求序列化（serialize）与响应翻译（translate）的 OpenAI 兼容
// wire 格式处理。文件物理分开，经本入口聚合导出。
export * from "./serialize.ts";
export * from "./translate.ts";
