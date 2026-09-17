import { createSnapshotStore, type SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  BusyEnterBehavior,
  ComposerSubmitGesture,
  InputSubmitMode,
} from "../contract/composer-submission.ts";
import { BUSY_ENTER_FIELD, DEFAULT_BUSY_ENTER_BEHAVIOR } from "../../submission-settings.ts";
import type { ConversationSettings } from "../../submission-settings.ts";

export { DEFAULT_BUSY_ENTER_BEHAVIOR } from "../../submission-settings.ts";

export function resolveSubmitMode(
  preferred: BusyEnterBehavior,
  running: boolean,
  gesture: ComposerSubmitGesture,
  steeringAvailable: boolean,
): InputSubmitMode {
  if (!running || !steeringAvailable) return "queue";
  if (gesture === "enter") return preferred;
  return preferred === "queue" ? "steer" : "queue";
}

export class ComposerSubmissionPolicy {
  readonly busyEnter: SnapshotStore<BusyEnterBehavior> = createSnapshotStore(
    DEFAULT_BUSY_ENTER_BEHAVIOR,
  );
  private readonly host: SettingsScope<ConversationSettings> | undefined;

  constructor(host?: SettingsScope<ConversationSettings>) {
    this.host = host;
    if (host !== undefined) {
      host.subscribe(() => {
        this.adopt(host);
      });
      this.adopt(host);
    }
  }

  setBusyEnter(behavior: BusyEnterBehavior): void {
    if (this.busyEnter.getSnapshot() === behavior) return;
    this.busyEnter.set(behavior);
    void this.host?.set(BUSY_ENTER_FIELD, behavior);
  }

  private adopt(host: SettingsScope<ConversationSettings>): void {
    const section = host.getSnapshot().value;
    if (section === undefined || this.busyEnter.getSnapshot() === section.busyEnter) return;
    this.busyEnter.set(section.busyEnter);
  }
}
