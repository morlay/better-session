import { Context } from "@deepseek-ai/cordis";
import { SettingsProvider, type SettingsNamespace } from "@deepseek-ai/dsh-settings";

export class EmptySettings extends SettingsProvider {
  constructor(ctx: Context) {
    super(ctx);
  }

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
