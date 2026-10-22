export type SshProfile = {
  host: string;
  port: string;
  user: string;
  publicKey: string;
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
  source: { rsl10: string; relations: string; output: string; rsl11: string };
};
export const emptyProfile: Profile = {
  ssh: { host: "", port: "22", user: "", publicKey: "" },
  database: {
    host: "127.0.0.1",
    port: "5432",
    name: "",
    user: "",
    ssl: "prefer",
  },
  source: { rsl10: "", relations: "", output: "", rsl11: "" },
};
declare global {
  interface Window {
    desktop?: {
      choosePublicKey(): Promise<string | null>;
      connect(profile: SshProfile): Promise<{ state: string }>;
      disconnect(): Promise<void>;
      write(data: string): void;
      resize(cols: number, rows: number): void;
      onData(callback: (data: string) => void): () => void;
      onExit(callback: (code: number) => void): () => void;
    };
  }
}
