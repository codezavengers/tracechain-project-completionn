import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { BitcoinProvider } from "./bitcoin"

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

const ADDRESS = "1BitcoinEaterAddressDontSendf59kuE"

function makeTx(txid: string, confirmed: boolean, blockTime: number | null, netSats: number) {
  return {
    txid,
    status: { confirmed, block_height: confirmed ? 800000 : undefined, block_time: blockTime ?? undefined },
    vin: netSats < 0 ? [{ prevout: { scriptpubkey_address: ADDRESS, value: Math.abs(netSats) } }] : [],
    vout:
      netSats >= 0
        ? [{ scriptpubkey_address: ADDRESS, value: netSats }]
        : [{ scriptpubkey_address: "bc1other", value: Math.abs(netSats) }],
  }
}

describe("BitcoinProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("is always configured (public keyless explorer)", () => {
    expect(new BitcoinProvider().isConfigured()).toBe(true)
  })

  it("projects a UTXO transaction into the common Transaction shape with a real timestamp", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce(jsonResponse([makeTx("t1", true, 1700000000, 50000)]))
    const provider = new BitcoinProvider()
    const txs = await provider.getTransactions(ADDRESS)
    expect(txs).toHaveLength(1)
    expect(txs[0].timestamp).toBe(new Date(1700000000 * 1000).toISOString())
    expect(txs[0].direction).toBeUndefined() // normalizeNative only sets direction when a reference address is passed explicitly
  })

  it("never fabricates 'now' for an unconfirmed transaction with no block_time", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce(jsonResponse([makeTx("t1", false, null, 1000)]))
    const provider = new BitcoinProvider()
    const txs = await provider.getTransactions(ADDRESS)
    expect(txs[0].timestamp).toBeNull()
  })

  it("paginates via the last-seen-confirmed-txid cursor until a short page ends history", async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => makeTx(`c${i}`, true, 1700000000 + i, 1000))
    const shortPage = Array.from({ length: 5 }, (_, i) => makeTx(`d${i}`, true, 1700001000 + i, 1000))
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce(jsonResponse(fullPage)).mockResolvedValueOnce(jsonResponse(shortPage))

    const provider = new BitcoinProvider()
    const { transactions, meta } = await provider.getTransactionsPaged(ADDRESS)
    expect(transactions).toHaveLength(30)
    expect(meta.pagesFetched).toBe(2)
    expect(meta.truncated).toBe(false)
    // second call should have used the /txs/chain/{lastTxid} cursor endpoint
    const secondUrl = mockFetch.mock.calls[1][0] as string
    expect(secondUrl).toContain("/txs/chain/c24")
  })

  it("truncates once the investigation cap is reached", async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => makeTx(`c${i}`, true, 1700000000 + i, 1000))
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    // A fresh Response must be produced per call — a Response body can only
    // be read (via .json()) once.
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(fullPage)))

    const provider = new BitcoinProvider()
    const { transactions, meta } = await provider.getTransactionsPaged(ADDRESS, "bitcoin", { maxTransactions: 30, maxPages: 5 })
    expect(transactions.length).toBeLessThanOrEqual(30)
    expect(meta.truncated).toBe(true)
  })

  it("never reports usdValue as 0 — null when unpriced", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce(jsonResponse([makeTx("t1", true, 1700000000, 50000)]))
    const provider = new BitcoinProvider()
    const txs = await provider.getTransactions(ADDRESS)
    expect(txs[0].usdValue).toBeNull()
  })

  it("returns no token transfers (Bitcoin has no token layer)", async () => {
    const provider = new BitcoinProvider()
    expect(await provider.getTokenTransfers()).toEqual([])
  })

  it("never reports blockHeight as 0 for an unconfirmed transaction", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce(jsonResponse([makeTx("unconfirmed1", false, null, 1000)]))
    const provider = new BitcoinProvider()
    const txs = await provider.getTransactions(ADDRESS)
    expect(txs[0].blockHeight).toBeNull()
    expect(txs[0].blockHeight).not.toBe(0)
  })

  it("never reports usdBalance as 0 for a non-zero live balance — null when unpriced", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ chain_stats: { funded_txo_sum: 100000, spent_txo_sum: 0, tx_count: 1 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } }),
    )
    const provider = new BitcoinProvider()
    const balance = await provider.getWalletBalance(ADDRESS)
    expect(balance.balance).toBeGreaterThan(0)
    expect(balance.usdBalance).toBeNull()
    expect(balance.usdBalance).not.toBe(0)
  })

  const TS_2024_06 = Math.floor(Date.parse("2024-06-01T00:00:00Z") / 1000)
  const TS_2024_03 = Math.floor(Date.parse("2024-03-01T00:00:00Z") / 1000)
  const TS_2023_12 = Math.floor(Date.parse("2023-12-01T00:00:00Z") / 1000)

  it("applies endDate by skipping confirmed transactions newer than the bound", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    mockFetch.mockResolvedValueOnce(
      jsonResponse([makeTx("new", true, TS_2024_06, 1000), makeTx("keep", true, TS_2024_03, 1000)]),
    )
    const provider = new BitcoinProvider()
    const { transactions } = await provider.getTransactionsPaged(ADDRESS, "bitcoin", { endDate: "2024-04-01" })
    expect(transactions.map((t) => t.hash)).toEqual(["keep"])
  })

  it("applies startDate and stops paging at the first older-than-start confirmed tx", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>
    // Would loop forever if early-stop failed, since every page repeats.
    mockFetch.mockResolvedValue(
      jsonResponse([makeTx("keep", true, TS_2024_06, 1000), makeTx("old", true, TS_2023_12, 1000)]),
    )
    const provider = new BitcoinProvider()
    const { transactions, meta } = await provider.getTransactionsPaged(ADDRESS, "bitcoin", { startDate: "2024-01-01" })
    expect(transactions.map((t) => t.hash)).toEqual(["keep"])
    expect(meta.truncated).toBe(false)
    expect(meta.pagesFetched).toBe(1)
  })
})
