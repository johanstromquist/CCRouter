export interface Session {
  session_id: string;
  friendly_name: string;
  pid: number | null;
  cwd: string | null;
  workspace_folders: string | null; // JSON array
  ide_name: string | null;
  lock_port: number | null;
  registered_at: string;
  last_seen_at: string;
  is_active: number; // 0 or 1
  name_custom?: number; // 1 if the name was explicitly set by user or inherited from a custom-named predecessor
}

export function isSessionActive(s: Session): boolean {
  return s.is_active === 1;
}

export interface BridgeRegistry {
  port: number;
  pid: number;
  host?: string;
  remote?: boolean;
  platform?: string;
  started: number;
}

export interface Message {
  id: number;
  from_session: string; // friendly_name of sender
  channel: string; // channel name (e.g. "#deploy")
  content: string;
  created_at: string;
  read_at: string | null;
}

export interface ChannelMember {
  channel_name: string;
  session_name: string; // friendly_name of the session
  joined_at: string;
}

export interface ChannelInvite {
  id: number;
  channel_name: string;
  from_session: string; // friendly_name of inviter
  to_session: string; // friendly_name of target
  created_at: string;
  status: "pending" | "accepted" | "declined";
}

export interface RegisterRequest {
  session_id: string;
  pid?: number;
  cwd?: string;
  desired_name?: string;
  workspace_folders?: string[];
  ide_name?: string;
  lock_port?: number;
}

export interface RegisterResponse {
  friendly_name: string;
  session_id: string;
}
