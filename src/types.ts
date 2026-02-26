export interface Session {
  session_id: string;
  friendly_name: string;
  pid: number | null;
  tty: string | null;
  cwd: string | null;
  workspace_folders: string | null; // JSON array
  ide_name: string | null;
  lock_port: number | null;
  registered_at: string;
  last_seen_at: string;
  is_active: number; // 0 or 1
}

export interface Message {
  id: number;
  from_session: string; // friendly_name of sender
  to_session: string; // friendly_name, session_id, or "*"
  content: string;
  created_at: string;
  read_at: string | null;
}

export interface RegisterRequest {
  session_id: string;
  pid?: number;
  tty?: string;
  cwd?: string;
  workspace_folders?: string[];
  ide_name?: string;
  lock_port?: number;
}

export interface RegisterResponse {
  friendly_name: string;
  session_id: string;
}
