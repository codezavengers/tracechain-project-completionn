import type { Chain, Transaction } from "@/lib/types"
import { AbstractProvider } from "./base"
import { fetchJson } from "@/lib/blockchain/net"
import { getChainConfig } from "@/lib/blockchain/config"
import { normalizeNative, parseDateBounds, classifyTimestamp } from "@/lib/blockchain/normalize"
import {
  MAX_INVESTIGATION_TRANSACTIONS,
  DEFAULT_MAX_PAGES,
  type DataSource,
  type PagedTransactions,
  type TokenTransfer,
  type TxQueryOptions,
  type WalletBalance,
} from "@/lib/blockchain/data-source"

// Blockstream/Esplora API shapes (public, keyless).
interface EsploraVin {
  prevout?: { scriptpubkey_address?: string; value?: number }
}
interface EsploraVout {
  scriptpubkey_address?: string
  value?: number
}
interface EsploraTx {
  txid: string
  status: { confirmed: boolean; block_height?: number; block_time?: number }
  vin: EsploraVin[]
  vout: EsploraVout[]
}
interface EsploraAddress {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number }
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number }
}

const SATS = 100_000_000
// Esplora returns at most 25 confirmed rows per page (plus any unconfirmed
// ones on the first page). Fewer than that means we've reached the end.
const ESPLORA_PAGE_SIZE = 25

// Direct Bitcoin explorer adapter — yields LIVE data. The UTXO model is
// projected onto the simplified {from,to,amount} transaction shape by computing
// each transaction's net effect on the queried address.
export class BitcoinProvider extends AbstractProvider {
  readonly chain: Chain = "bitcoin"
  readonly name = "bitcoin:esplora"
  readonly nativeSource: DataSource = "LIVE"

  private base(): string {
    return getChainConfig("bitcoin").baseUrl
  }

  private projectTx(address: string, tx: EsploraTx): Transaction {
    const inputFromAddr = tx.vin.reduce((s, v) => s + (v.prevout?.scriptpubkey_address === address ? v.prevout?.value ?? 0 : 0), 0)
    const outputToAddr = tx.vout.reduce((s, v) => s + (v.scriptpubkey_address === address ? v.value ?? 0 : 0), 0)
    const net = outputToAddr - inputFromAddr
    const direction: "in" | "out" = net >= 0 ? "in" : "out"
    const counterparty =
      direction === "in"
        ? tx.vin[0]?.prevout?.scriptpubkey_address ?? "unknown"
        : tx.vout.find((v) => v.scriptpubkey_address && v.scriptpubkey_address !== address)?.scriptpubkey_address ??
          "unknown"
    return normalizeNative({
      hash: tx.txid,
      chain: "bitcoin",
      from: direction === "in" ? counterparty : address,
      to: direction === "in" ? address : counterparty,
      amount: Math.abs(net) / SATS,
      asset: "BTC",
      timestamp: tx.status.block_time ? new Date(tx.status.block_time * 1000).toISOString() : null,
      // Unconfirmed transactions have no block height yet — null, never 0.
      blockHeight: tx.status.confirmed ? tx.status.block_height ?? null : null,
      provenance: "LIVE_BLOCKCHAIN_DATA",
      // Esplora enumerates an address's full history — Bitcoin Core RPC has
      // no such call, so this is a live indexing provider, not raw RPC.
      sourceType: "LIVE_INDEXED",
    })
  }

  // Esplora paginates via a "last seen confirmed txid" cursor rather than a
  // page number: /address/{addr}/txs returns the newest page (unconfirmed +
  // up to 25 confirmed); /address/{addr}/txs/chain/{last_txid} returns the
  // next 25 confirmed rows older than that txid.
  async getTransactionsPaged(address: string, _chain?: Chain, options: TxQueryOptions = {}): Promise<PagedTransactions> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
    const cap = Math.min(options.maxTransactions ?? MAX_INVESTIGATION_TRANSACTIONS, MAX_INVESTIGATION_TRANSACTIONS)
    const bounds = parseDateBounds(options)

    const all: Transaction[] = []
    let pagesFetched = 0
    let truncated = false
    let reachedWindowEnd = false
    let lastSeenTxid: string | undefined

    for (let page = 0; page < maxPages; page++) {
      const path = lastSeenTxid
        ? `/address/${encodeURIComponent(address)}/txs/chain/${lastSeenTxid}`
        : `/address/${encodeURIComponent(address)}/txs`
      const rows = await fetchJson<EsploraTx[]>(`${this.base()}${path}`, { label: "bitcoin txs" })
      pagesFetched++
      if (rows.length === 0) break

      for (const t of rows) {
        const tx = this.projectTx(address, t)
        const cls = classifyTimestamp(tx.timestamp, bounds)
        if (cls === "after") continue // newer than endDate — keep scanning
        if (cls === "before") {
          // Confirmed history is newest-first, so once a confirmed tx is older
          // than startDate nothing older can match.
          reachedWindowEnd = true
          break
        }
        all.push(tx)
        if (all.length >= cap) break
      }
      if (all.length >= cap) {
        truncated = true
        break
      }
      if (reachedWindowEnd) break

      const confirmedRows = rows.filter((t) => t.status.confirmed)
      if (confirmedRows.length < ESPLORA_PAGE_SIZE) break // reached the end of history
      lastSeenTxid = confirmedRows[confirmedRows.length - 1].txid
    }

    return {
      transactions: all.slice(0, cap),
      meta: { totalFetched: all.length, pagesFetched, truncated },
    }
  }

  async getTransactions(address: string, chain?: Chain, options?: TxQueryOptions): Promise<Transaction[]> {
    const { transactions } = await this.getTransactionsPaged(address, chain, options)
    return transactions
  }

  async getTransaction(hash: string): Promise<Transaction | null> {
    try {
      const tx = await fetchJson<EsploraTx>(`${this.base()}/tx/${encodeURIComponent(hash)}`, { label: "bitcoin tx" })
      // Without a reference address, report the largest output as the movement.
      const largest = [...tx.vout].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]
      return normalizeNative({
        hash: tx.txid,
        chain: "bitcoin",
        from: tx.vin[0]?.prevout?.scriptpubkey_address ?? "unknown",
        to: largest?.scriptpubkey_address ?? "unknown",
        amount: (largest?.value ?? 0) / SATS,
        asset: "BTC",
        timestamp: tx.status.block_time ? new Date(tx.status.block_time * 1000).toISOString() : null,
        blockHeight: tx.status.confirmed ? tx.status.block_height ?? null : null,
        provenance: "LIVE_BLOCKCHAIN_DATA",
        // Single-hash lookup against Esplora's live API.
        sourceType: "LIVE_API",
      })
    } catch {
      return null
    }
  }

  async getWalletBalance(address: string): Promise<WalletBalance> {
    const info = await fetchJson<EsploraAddress>(`${this.base()}/address/${encodeURIComponent(address)}`, {
      label: "bitcoin balance",
    })
    const sats = info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum
    // No price data at this layer — null (never 0) means "unpriced"; enriched
    // in service.ts when a price provider is configured.
    return { address, chain: "bitcoin", balance: sats / SATS, asset: "BTC", usdBalance: null }
  }

  // Bitcoin has no native token layer.
  async getTokenTransfers(): Promise<TokenTransfer[]> {
    return []
  }
}
