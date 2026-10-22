import defaults from "../shared/defaults.json";
export type SshProfile = {
  host: string;
  port: string;
  user: string;
  privateKey: string;
};
export type Profile = {
  ssh: SshProfile;
  database: {
    host: string;
    port: string;
    name: string;
    user: string;
    ssl: string;
  };
  processing: {
    library: string;
    container: string;
    watcher: string;
    packageRsl10: string;
    importIdRsl10: string;
    stageReportRsl10: string;
    analysisReportRsl10: string;
    dryRunReportRsl10: string;
    applyReportRsl10: string;
    packageRsl11: string;
    importIdRsl11: string;
    stageReportRsl11: string;
    analysisReportRsl11: string;
    dryRunReportRsl11: string;
    applyReportRsl11: string;
  };
  source: { rsl10: string; relations: string; output: string; rsl11: string };
};
export type DatabaseTestResult = {
  ok: boolean;
  message: string;
  durationMs: number;
  details?: {
    database: string;
    username: string;
    version: string;
    address: string | null;
    port: number | null;
    ssl: boolean;
  };
};
export type AuthorityAction =
  | "container-status"
  | "worker-status"
  | "delivery-status"
  | "help"
  | "prepare-rsl10"
  | "prepare-rsl11"
  | "task-log"
  | "task-report"
  | "inspect-package"
  | "check-worker-db"
  | "stage-rsl10"
  | "analyze-rsl10"
  | "dry-run-rsl10"
  | "apply-rsl10"
  | "verify-rsl10"
  | "stage-rsl11"
  | "analyze-rsl11"
  | "dry-run-rsl11"
  | "apply-rsl11"
  | "verify-rsl11";
export type WorkerState = {
  busy: boolean;
  accepting: boolean;
  outputOnServer?: string;
  task?: {
    id: string;
    stage: string;
    status: string;
    input?: string;
    output?: string;
    result?: string;
    log?: string;
    startedAt?: string;
    finishedAt?: string;
    importId?: string;
    library?: string;
    dryRun?: boolean;
    exitCode?: number | null;
  };
};
export type ContainerState = {
  state: { Running: boolean; Status?: string };
  image: string;
  mounts: { Source: string; Destination: string }[];
};
export type AuthorityResult = {
  ok: boolean;
  message: string;
  durationMs: number;
  exitCode?: number | null;
  command?: string;
  stdout?: string;
  stderr?: string;
  data?: unknown;
  observation?: {
    worker: WorkerState;
    taskId: string;
    observedAt: string;
    log?: string;
    report?: unknown;
  };
  checkpointUpdates?: Partial<Profile["processing"]>;
  uncertain?: boolean;
  importIdRsl10?: string;
  stageReportRsl10?: string;
};
export type OperationEvent = {
  id: string;
  kind: "command" | "stdout" | "stderr" | "finished";
  text: string;
};
export const emptyProfile: Profile = {
  ssh: { host: "", port: "22", user: "", privateKey: "" },
  database: {
    host: "127.0.0.1",
    port: "5432",
    name: "",
    user: "",
    ssl: "prefer",
  },
  processing: { ...defaults.processing },
  source: { rsl10: "", relations: "", output: "", rsl11: "" },
};
declare global {
  interface Window {
    desktop?: {
      choosePrivateKey(): Promise<string | null>;
      connect(profile: SshProfile): Promise<{ state: string }>;
      testDatabase(request: {
        ssh: SshProfile;
        database: Profile["database"];
        password: string;
      }): Promise<DatabaseTestResult>;
      runAuthority(request: {
        action: AuthorityAction;
        profile: Pick<Profile, "ssh" | "source" | "processing">;
      }): Promise<AuthorityResult>;
      onOperationEvent(callback: (event: OperationEvent) => void): () => void;
      disconnect(): Promise<void>;
      write(data: string): void;
      resize(cols: number, rows: number): void;
      onData(callback: (data: string) => void): () => void;
      onExit(callback: (code: number) => void): () => void;
    };
  }
}
