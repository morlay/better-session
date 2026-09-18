import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join } from "node:path";

interface ReadyEvent {
  readonly type: "ready";
  readonly url: string;
  readonly injections?: readonly unknown[] | undefined;
}

interface FatalEvent {
  readonly type: "fatal";
  readonly message: string;
}

type DesktopHostEvent =
  | ReadyEvent
  | FatalEvent
  | { readonly type: "shutdown-complete" }
  | {
      readonly type: "update-tasks";
      readonly requestId: number;
      readonly active: boolean;
      readonly error?: string;
    };

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024;

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== "object" || message === null || !("type" in message)) return false;
  const candidate = message as Record<string, unknown>;
  switch (candidate.type) {
    case "shutdown-complete":
      return true;
    case "ready":
      return typeof candidate.url === "string";
    case "fatal":
      return typeof candidate.message === "string";
    case "update-tasks":
      return (
        Number.isSafeInteger(candidate.requestId) &&
        typeof candidate.active === "boolean" &&
        (candidate.error === undefined || typeof candidate.error === "string")
      );
    default:
      return false;
  }
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([exit.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface DesktopHostReady {
  readonly url: string;
  readonly injections?: readonly unknown[] | undefined;
}

export type DesktopHostSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface DesktopHostOptions {
  readonly nodeArgs?: readonly string[];

  readonly extraEnv?: Readonly<Record<string, string>>;

  readonly primaryRuntime?: string;

  readonly profileResolution?: "link" | "runtime";

  readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string };

  readonly spawn?: DesktopHostSpawn;
}

export class DesktopHostProcess {
  private child: ChildProcess | undefined;
  private readyResolve!: (ready: DesktopHostReady) => void;
  private readyReject!: (error: Error) => void;
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  private exitPromise: Promise<void> | undefined;
  private stderr = "";
  private failureReported = false;
  private stopping = false;
  private nextControlId = 1;
  private readonly taskQueries = new Map<
    number,
    { resolve: (active: boolean) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly options: DesktopHostOptions = {},
  ) {}

  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise;
    const entry = join(
      this.runtimeDir,
      "node_modules",
      "@deepseek-ai",
      "dsh-desktop-host",
      "lib",
      "index.js",
    );
    const primaryRuntime =
      this.options.primaryRuntime ?? join(this.runtimeDir, "..", "runtime", "primary-runtime");
    const packageManager = this.options.packageManager;
    const args = [
      "--expose-internals",
      ...(this.inspectPort === undefined
        ? []
        : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      ...(this.options.nodeArgs ?? []),
      entry,
      this.runtimeDir,
      this.projectDir,
      primaryRuntime,
      this.options.profileResolution ?? "link",
      ...(packageManager === undefined ? [] : [packageManager.pnpm, packageManager.nodeBin]),
    ];
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            name !== "NODE_OPTIONS" &&
            !name.startsWith("DSH_DESKTOP_") &&
            !/^(?:npm|pnpm|corepack)_/iu.test(name),
        ),
      ),
      ...this.options.extraEnv,
    };
    const spawnChild = this.options.spawn ?? spawn;
    const child = spawnChild(this.node, args, {
      cwd: this.projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS);
      process.stderr.write(`[dsh-host] ${chunk}`);
    });
    child.stdout?.pipe(process.stdout);
    child.on("message", (message: unknown) => {
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error("dsh desktop host sent an invalid IPC event"));
        this.killChild("SIGTERM");
        return;
      }
      this.handleMessage(message);
    });
    child.once("error", (error) => {
      this.fail(error);
    });
    this.exitPromise = new Promise<void>((resolve) => {
      child.once("close", (code) => {
        const suffix = this.stderr.trim() === "" ? "" : `: ${this.stderr.trim()}`;
        if (code !== 0 && code !== null)
          this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`));
        else this.fail(new Error(`dsh desktop host stopped${suffix}`));
        resolve();
      });
    });
    return this.readyPromise;
  }

  async updateTasks(action: "inspect" | "lock" | "unlock"): Promise<boolean> {
    const child = this.child;
    if (child === undefined || !child.connected || this.failureReported || this.stopping) {
      throw new Error("desktop update: Host is unavailable");
    }
    const requestId = this.nextControlId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<boolean>((resolve, reject) => {
        this.taskQueries.set(requestId, { resolve, reject });
        timer = setTimeout(() => {
          reject(new Error("desktop update: task inspection timed out"));
        }, 10_000);
        child.send({ type: "update-tasks", requestId, action }, (error) => {
          if (error !== null) reject(error);
        });
      });
    } finally {
      clearTimeout(timer);
      this.taskQueries.delete(requestId);
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    this.stopping = true;
    if (child.connected)
      child.send({ type: "shutdown" }, (error) => {
        if (error !== null) this.fail(error);
      });
    const exited = this.exitPromise ?? Promise.resolve();
    const graceful = await exitsWithin(exited, 10_000);
    if (!graceful) this.killChild("SIGTERM");
    if (!(await exitsWithin(exited, 5_000))) {
      this.killChild("SIGKILL");
      if (!(await exitsWithin(exited, 5_000))) {
        throw new Error("dsh desktop host did not exit after SIGKILL");
      }
    }
    this.child = undefined;
  }

  private killChild(signal: NodeJS.Signals): void {
    const child = this.child;
    if (child === undefined || child.pid === undefined) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    child.kill(signal);
  }

  private handleMessage(message: DesktopHostEvent): void {
    switch (message.type) {
      case "ready":
        this.readyResolve({ url: message.url, injections: message.injections });
        return;
      case "shutdown-complete":
        if (!this.stopping)
          this.fail(new Error("dsh desktop host acknowledged an unrequested shutdown"));
        return;
      case "fatal":
        this.fail(new Error(message.message));
        return;
      default: {
        const query = this.taskQueries.get(message.requestId);
        if (message.error === undefined) query?.resolve(message.active);
        else query?.reject(new Error(message.error));
        return;
      }
    }
  }

  private fail(error: Error): void {
    this.readyReject(error);
    for (const query of this.taskQueries.values()) query.reject(error);
    this.taskQueries.clear();
    if (!this.failureReported && !this.stopping) this.failureReported = true;
  }
}
