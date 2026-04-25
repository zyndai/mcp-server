/**
 * Lazily-initialized x402 payment fetch wrapper.
 *
 * If the user sets `ZYNDAI_PAYMENT_PRIVATE_KEY` (or the legacy
 * `ZYNDAI_PRIVATE_KEY`), we wrap global `fetch` so that any 402 response
 * from a paid agent is auto-settled with USDC on Base Sepolia. If the env
 * var isn't set, paid calls will surface the 402 to the model so it can
 * tell the user how to configure payment.
 *
 * Lazy: x402 packages are fairly heavy (viem + EVM wallet plumbing); we
 * only load them on first call to keep MCP startup fast for users who
 * never call paid agents.
 */

let resolvedFetch: typeof fetch | null = null;
let initialized = false;

function getPrivateKey(): `0x${string}` | null {
  const raw =
    process.env["ZYNDAI_PAYMENT_PRIVATE_KEY"] ?? process.env["ZYNDAI_PRIVATE_KEY"];
  if (!raw) return null;

  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (hex.length !== 66) {
    console.error(
      `Invalid payment private key length: expected 64 hex chars (got ${hex.length - 2}). Skipping x402 setup.`,
    );
    return null;
  }
  return hex as `0x${string}`;
}

export async function getPaymentFetchAsync(): Promise<typeof fetch> {
  if (resolvedFetch) return resolvedFetch;
  if (initialized) return fetch;
  initialized = true;

  const privateKey = getPrivateKey();
  if (!privateKey) {
    resolvedFetch = fetch;
    return fetch;
  }

  try {
    // Dynamic import keeps these out of the cold-start path when no
    // payment key is configured.
    const { x402Client } = await import("@x402/core/client");
    const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
    const { toClientEvmSigner } = await import("@x402/evm");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { createPublicClient, http } = await import("viem");
    const { baseSepolia } = await import("viem/chains");
    const { wrapFetchWithPayment } = await import("@x402/fetch");

    const account = privateKeyToAccount(privateKey);
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(),
    });
    const signer = toClientEvmSigner(account, publicClient);
    const x402 = registerExactEvmScheme(new x402Client(), { signer });

    const wrapped = wrapFetchWithPayment(fetch, x402) as typeof fetch;
    resolvedFetch = wrapped;
    console.error(
      `x402 payment client initialized for ${account.address} (Base Sepolia)`,
    );
    return wrapped;
  } catch (err) {
    console.error(
      "Failed to initialize x402 payment client — paid agent calls will surface 402:",
      err instanceof Error ? err.message : String(err),
    );
    resolvedFetch = fetch;
    return fetch;
  }
}
