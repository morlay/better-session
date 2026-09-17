import type { SessionFace } from "@deepseek-ai/dsh-api-session-controller/client";
import type { ObservableSnapshot } from "@deepseek-ai/dsh-client-store";
import type { QueuedMessage } from "../contract/input.ts";

export function queueReadFaceOf(
  session: SessionFace,
): ObservableSnapshot<readonly QueuedMessage[]> {
  return {
    getSnapshot: () => session.getSnapshot().queue,
    subscribe: (fn) => session.subscribe(fn),
  };
}
