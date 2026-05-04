import { z } from "zod";
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from "../constants.js";

/**
 * Search the AgentDNS network. Mirrors the canonical `SearchRequest` shape
 * from the zyndai SDK so any field the registry knows about is exposed to
 * the model.
 */
export const SearchAgentsSchema = z
  .object({
    query: z
      .string()
      .max(500, "Query must not exceed 500 characters")
      .optional()
      .describe(
        "Natural-language search query. Examples: 'stock analysis', 'pdf summarizer', 'spanish translator'. Omit to browse the registry by filters only.",
      ),
    category: z
      .string()
      .optional()
      .describe(
        "Filter by category (e.g. 'finance', 'productivity', 'general'). Use the zyndai_resolve_fqan tool to discover categories.",
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        "Filter by tags. Examples: ['langchain', 'multi-agent'], ['nlp', 'translation'].",
      ),
    skills: z
      .array(z.string())
      .optional()
      .describe("Filter by declared skills."),
    protocols: z
      .array(z.string())
      .optional()
      .describe(
        "Filter by communication protocol. Examples: ['http'] (most common), ['mqtt'].",
      ),
    languages: z
      .array(z.string())
      .optional()
      .describe(
        "Filter by spoken/text language(s). ISO codes — examples: ['en', 'es', 'ja'].",
      ),
    models: z
      .array(z.string())
      .optional()
      .describe(
        "Filter by underlying LLM model. Examples: ['gpt-4o-mini'], ['claude-sonnet'].",
      ),
    min_trust_score: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Minimum registry trust score (0–1)."),
    status: z
      .enum(["online", "offline", "any"])
      .optional()
      .describe("Filter by entity status (default: online)."),
    federated: z
      .boolean()
      .optional()
      .describe(
        "If true, query peer registries in the federation in addition to the configured one.",
      ),
    enrich: z
      .boolean()
      .optional()
      .describe(
        "If true, the registry hydrates each hit with its full entity card (more bytes, but saves a follow-up zyndai_get_agent call).",
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_LIMIT)
      .default(DEFAULT_SEARCH_LIMIT)
      .describe("Max results 1-100 (default 10)."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Skip N results — pagination."),
  })
  .strict();

export const ListAgentsSchema = z
  .object({
    category: z.string().optional().describe("Filter by category."),
    tags: z.array(z.string()).optional().describe("Filter by tags."),
    federated: z.boolean().optional().describe("Federated query."),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_LIMIT)
      .default(DEFAULT_LIST_LIMIT)
      .describe("Max results 1-100 (default 20)."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Skip N results — pagination."),
  })
  .strict();

export const GetAgentSchema = z
  .object({
    entity_id: z
      .string()
      .min(1)
      .describe(
        "AgentDNS entity ID — looks like 'zns:a90cb541…' or 'zns:svc:…'. Get one from search results.",
      ),
  })
  .strict();

export const ResolveFqanSchema = z
  .object({
    fqan: z
      .string()
      .min(1)
      .describe(
        "Fully-qualified agent name. Format: '<entity_name>.<dev_handle>.zynd' (e.g. 'stocks.alice.zynd'). Resolves to an entity card.",
      ),
  })
  .strict();

export const CallAgentSchema = z
  .object({
    entity_id: z
      .string()
      .min(1)
      .describe(
        "Entity ID of the target agent — get it from search results or zyndai_resolve_fqan.",
      ),
    message: z
      .string()
      .min(1)
      .max(10_000)
      .optional()
      .describe(
        "Free-form text to send (TextPart). Use for chat-shaped agents. " +
          "If the target advertises an input_schema expecting a structured object, prefer `payload` instead.",
      ),
    payload: z
      .record(z.unknown())
      .optional()
      .describe(
        "Structured JSON object to send (DataPart). Use this when the agent/service's input_schema expects fields like {url, query, ...}. " +
          "At least one of `message` or `payload` must be provided.",
      ),
    conversation_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional conversation ID for multi-turn — pass back the value from a prior response to keep context.",
      ),
    mode: z
      .enum(["auto", "sync", "push"])
      .default("auto")
      .describe(
        "Delivery channel: " +
          "'sync' blocks the call until the agent finishes (best for quick replies); " +
          "'push' fires-and-forgets — the agent POSTs the result to your persona-runner when done, and you fetch it later via zyndai_async_replies (best for long jobs); " +
          "'auto' (default) inspects the agent card's capabilities + the message size and picks. Pick 'push' for transcribe/render/large-batch jobs you don't want to block on.",
      ),
    transport: z
      .enum(["auto", "JSONRPC", "HTTP+JSON"])
      .default("auto")
      .describe(
        "Wire transport advertised on the agent card. " +
          "'auto' (default) follows the card's preferredTransport; " +
          "'JSONRPC' = signed JSON-RPC `message/send`; " +
          "'HTTP+JSON' = plain POST of MessageSendParams. " +
          "Inspect zyndai_get_agent's Transports section first to see what the agent advertises. " +
          "Push mode forces JSONRPC.",
      ),
  })
  .strict();

/** zyndai_call_service mirrors call_agent — services are stateless agents on the network. */
export const CallServiceSchema = CallAgentSchema;

export type SearchAgentsInput = z.infer<typeof SearchAgentsSchema>;
export type ListAgentsInput = z.infer<typeof ListAgentsSchema>;
export type GetAgentInput = z.infer<typeof GetAgentSchema>;
export type ResolveFqanInput = z.infer<typeof ResolveFqanSchema>;
export type CallAgentInput = z.infer<typeof CallAgentSchema>;
export type CallServiceInput = z.infer<typeof CallServiceSchema>;
