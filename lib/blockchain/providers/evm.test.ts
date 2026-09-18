import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EthereumProvider } from "./evm"

function rpcResponse(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function methodOf(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body ?? "{}"))
  return body.method
}

const ADDRESS = "0x000000000000000000000000000000000000dEaD"
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3e"

describe("EvmProvider (Ethereum, direct RPC)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("isConfigured is true out of the box via the free public RPC endpoint", () => {
    const provider = new EthereumProvider()
    expect(provider.isConfigured()).toBe(true)
  })

  it("getWalletBalance reads eth_getBalance directly, with a null (never 0) usdBalance", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce(rpcResponse("0xde0b6b3a7640000"))

    const provider = new EthereumProvider()
    const balance = await provider.getWalletBalance(ADDRESS)
    expect(balance.balance).toBeCloseTo(1, 6)
    expect(balance.usdBalance).toBeNull()
    expect(methodOf(mockFetch.mock.calls[0][1])).toBe("eth_getBalance")
  })

  it("getTransaction resolves the real block timestamp instead of the current time", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch
      .mockResolvedValueOnce(
        rpcResponse({ hash: "0xhash", from: "0xa", to: "0xb", value: "0xde0b6b3a7640000", blockNumber: "0x64" }),
      )
      .mockResolvedValueOnce(rpcResponse({ timestamp: "0x60000000" }))

    const provider = new EthereumProvider()
    const tx = await provider.getTransaction("0xhash")
    expect(tx).not.toBeNull()
    expect(tx?.timestamp).toBe(new Date(Number(0x60000000) * 1000).toISOString())
    expect(tx?.amount).toBeCloseTo(1, 6)
    expect(tx?.sourceType).toBe("RAW_RPC")
  })

  it("getTransaction returns a null timestamp (never 'now') when the block lookup fails", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch
      .mockResolvedValueOnce(rpcResponse({ hash: "0xhash", from: "0xa", to: "0xb", value: "0x1", blockNumber: "0x65" }))
      .mockRejectedValueOnce(new Error("block lookup failed"))

    const before = Date.now()
    const provider = new EthereumProvider()
    const tx = await provider.getTransaction("0xhash")
    expect(tx?.timestamp).toBeNull()
    expect(tx?.timestamp === null || new Date(tx!.timestamp as string).getTime() !== before).toBe(true)
  })

  it("getTransaction returns null for an unknown hash", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce(rpcResponse(null))
    const provider = new EthereumProvider()
    const tx = await provider.getTransaction("0xunknown")
    expect(tx).toBeNull()
  })

  it("returns a null (never 0) blockHeight when a transaction's block number cannot be parsed", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce(rpcResponse({ hash: "0xhash", from: "0xa", to: "0xb", value: "0x1", blockNumber: null }))
    const provider = new EthereumProvider()
    const tx = await provider.getTransaction("0xhash-noblock")
    expect(tx?.blockHeight).toBeNull()
    expect(tx?.blockHeight).not.toBe(0)
  })

  it("getTransactionsPaged honestly reports native history as unsupported instead of fabricating a list", async () => {
    const provider = new EthereumProvider()
    const { transactions, meta } = await provider.getTransactionsPaged(ADDRESS)
    expect(transactions).toEqual([])
    expect(meta.unsupported).toBe(true)
    expect(meta.unsupportedReason).toMatch(/indexer/i)
  })

  it("getTransactions (the plain array accessor) also returns [] rather than fabricated rows", async () => {
    const provider = new EthereumProvider()
    const txs = await provider.getTransactions(ADDRESS)
    expect(txs).toEqual([])
  })

  it("getTokenTransfersPaged scans Transfer-event logs via eth_getLogs against the live node", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === "eth_blockNumber") return Promise.resolve(rpcResponse("0x100"))
      if (method === "eth_getLogs") {
        const body = JSON.parse(String(init.body))
        const topics = body.params[0].topics as (string | null)[]
        // First call (sent) filters on topics[1]=address; second (received) on topics[2].
        if (topics[1]) {
          return Promise.resolve(
            rpcResponse([
              {
                address: "0xtoken",
                topics: [
                  TRANSFER_TOPIC,
                  "0x000000000000000000000000000000000000000000000000000000000000dead",
                  "0x000000000000000000000000000000000000000000000000000000000000beef",
                ],
                data: "0x0000000000000000000000000000000000000000000000000000000000000001",
                blockNumber: "0x64",
                transactionHash: "0xlog1",
              },
            ]),
          )
        }
        return Promise.resolve(rpcResponse([]))
      }
      if (method === "eth_getBlockByNumber") return Promise.resolve(rpcResponse({ timestamp: "0x60000000" }))
      return Promise.resolve(rpcResponse(null))
    })

    const provider = new EthereumProvider()
    const { transfers, meta } = await provider.getTokenTransfersPaged(ADDRESS)
    expect(transfers).toHaveLength(1)
    expect(transfers[0].hash).toBe("0xlog1")
    expect(transfers[0].tokenAddress).toBe("0xtoken")
    expect(transfers[0].blockHeight).toBe(100)
    expect(meta.pagesFetched).toBeGreaterThanOrEqual(1)
  })

  it("never reports usdBalance as 0 for a live non-zero wallet balance — null when unpriced", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce(rpcResponse("0xde0b6b3a7640000"))
    const provider = new EthereumProvider()
    const balance = await provider.getWalletBalance(ADDRESS)
    expect(balance.usdBalance).toBeNull()
    expect(balance.usdBalance).not.toBe(0)
  })
})
