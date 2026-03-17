import { z } from "zod";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  DEFAULT_LIST_LIMIT,
} from "../constants.js";

export const SearchAgentsSchema = z.object({
  query: z
    .string()
    .min(1, "Query must not be empty")
    .max(500, "Query must not exceed 500 characters")
    .describe(
      "Natural language search query to find agents by name, description, or capabilities. Examples: 'stock analysis', 'weather forecast', 'code reviewer'",
    ),
  capabilities: z
    .array(z.string())
    .optional()
    .describe(
      "Optional capability tags to filter by. Examples: ['nlp', 'financial'], ['http', 'vision']",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .default(DEFAULT_SEARCH_LIMIT)
    .describe("Maximum number of results to return (1-100, default 10)"),
}).strict();

export const CallAgentSchema = z.object({
  agent_id: z
    .string()
    .min(1, "agent_id must not be empty")
    .describe(
      "ID of the target agent to call. Get this from search_agents or list_agents results.",
    ),
  message: z
    .string()
    .min(1, "Message must not be empty")
    .max(10_000, "Message must not exceed 10,000 characters")
    .describe("The message or query to send to the agent"),
  conversation_id: z
    .string()
    .min(1, "conversation_id must not be empty")
    .optional()
    .describe(
      "Optional conversation ID for multi-turn conversations. Omit for new conversations.",
    ),
}).strict();

export const ListAgentsSchema = z.object({
  status: z
    .enum(["ACTIVE", "INACTIVE", "DEPRECATED"])
    .default("ACTIVE")
    .describe("Filter by agent status (default: ACTIVE)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .default(DEFAULT_LIST_LIMIT)
    .describe("Maximum number of results to return (1-100, default 20)"),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of results to skip for pagination (default 0)"),
}).strict();

export const GetAgentSchema = z.object({
  agent_id: z
    .string()
    .min(1, "agent_id must not be empty")
    .describe("ID of the agent to retrieve details for"),
}).strict();

export type SearchAgentsInput = z.infer<typeof SearchAgentsSchema>;
export type CallAgentInput = z.infer<typeof CallAgentSchema>;
export type ListAgentsInput = z.infer<typeof ListAgentsSchema>;
export type GetAgentInput = z.infer<typeof GetAgentSchema>;
