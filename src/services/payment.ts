let resolvedFetch: typeof fetch | null = null;
let initialized = false;

function getPrivateKey(): `0x${string}` | null {
  const raw = process.env.ZYNDAI_PRIVATE_KEY;
  if (!raw) return null;

  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (hex.length !== 66) {
    console.error(`Invalid ZYNDAI_PRIVATE_KEY length: expected 64 hex chars`);
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

    resolvedFetch = wrapFetchWithPayment(fetch, x402);
    console.error(`x402 payment client initialized (${account.address})`);
    return resolvedFetch;
  } catch (err) {
    console.error(
      "x402 packages not available — paid agent calls will fail with 402:",
      err instanceof Error ? err.message : String(err),
    );
    resolvedFetch = fetch;
    return fetch;
  }
}
