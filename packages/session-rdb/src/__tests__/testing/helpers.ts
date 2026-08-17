/**
 * 测试用空 settings provider：无文件、空 section——插件经 settings namespace
 * 读取配置时回落到 entry config（与无 settings 服务的语义一致，但满足
 * `static inject: ['settings']` 的依赖要求）。
 */
import { SettingsProvider, type SettingsNamespace } from "@deepseek-ai/dsh-settings";

export class EmptySettings extends SettingsProvider {
  get writable(): boolean {
    return true;
  }

  protected async load(): Promise<Record<string, unknown>> {
    return {};
  }

  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve();
  }
}
