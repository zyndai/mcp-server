import {
  DEFAULT_REGISTRY_URL,
  REQUEST_TIMEOUT_MS,
} from "../constants.js";
import type {
  Agent,
  AgentListResponse,
  AgentDetailResponse,
} from "../types.js";

function getRegistryUrl(): string {
  return process.env.ZYNDAI_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

function getApiKey(): string | undefined {
  return process.env.ZYNDAI_API_KEY;
}

export async function registryRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${getRegistryUrl()}${path}`;
  const apiKey = getApiKey();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new RegistryError(
        `Registry returned ${response.status}: ${body || response.statusText}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchAgents(
  keyword: string,
  capabilities?: string[],
  limit?: number,
  offset?: number,
): Promise<AgentListResponse> {
  const params = new URLSearchParams();
  params.set("keyword", keyword);
  params.set("status", "ACTIVE");

  if (capabilities?.length) {
    params.set("capabilities", capabilities.join(","));
  }
  if (limit !== undefined) {
    params.set("limit", String(limit));
  }
  if (offset !== undefined) {
    params.set("offset", String(offset));
  }

  return registryRequest<AgentListResponse>(`/agents?${params.toString()}`);
}

export async function listAgents(
  status: string,
  limit: number,
  offset: number,
): Promise<AgentListResponse> {
  const params = new URLSearchParams({
    status,
    limit: String(limit),
    offset: String(offset),
  });

  return registryRequest<AgentListResponse>(`/agents?${params.toString()}`);
}

export async function getAgentById(
  agentId: string,
): Promise<Agent> {
  // GET /agents/:id requires JWT auth. Try it first (works if user has JWT),
  // then fall back to the public list endpoint filtered by keyword.
  try {
    const result = await registryRequest<AgentDetailResponse | Agent>(
      `/agents/${agentId}`,
    );

    if ("agent" in result && result.agent) {
      return result.agent;
    }
    return result as Agent;
  } catch (err) {
    if (err instanceof RegistryError && (err.statusCode === 401 || err.statusCode === 403)) {
      // GET /agents/:id requires JWT. Fall back to paging through the public list.
      const PAGE_SIZE = 100;
      const MAX_PAGES = 10;
      for (let page = 0; page < MAX_PAGES; page++) {
        const list = await registryRequest<AgentListResponse>(
          `/agents?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
        );
        const agent = list.data.find((a) => a.id === agentId);
        if (agent) return agent;
        if (list.data.length < PAGE_SIZE) break;
      }
      throw new RegistryError("Agent not found", 404);
    }
    throw err;
  }
}

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}
