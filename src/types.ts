export interface Agent {
  id: string;
  name: string;
  description: string | null;
  capabilities: Record<string, unknown> | null;
  status: AgentStatus;
  didIdentifier: string;
  did: string;
  httpWebhookUrl: string | null;
  mqttUri: string | null;
  inboxTopic: string | null;
  lastHealthCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentStatus = "ACTIVE" | "INACTIVE" | "DEPRECATED";

export interface AgentListResponse {
  data: Agent[];
  count: number;
  total: number;
}

export interface AgentDetailResponse {
  agent: Agent;
  credentials: unknown;
}

export interface AgentMessage {
  content: string;
  prompt: string;
  sender_id: string;
  receiver_id: string;
  message_type: string;
  message_id: string;
  conversation_id: string;
  in_reply_to: string | null;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export interface WebhookSyncResponse {
  status?: string;
  response?: string;
  output?: string;
  [key: string]: unknown;
}

export interface PaymentInfo {
  paid: boolean;
  transaction: string | null;
  network: string | null;
  payer: string | null;
}
