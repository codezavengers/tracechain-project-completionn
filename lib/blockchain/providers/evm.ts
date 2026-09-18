import type { Chain, Transaction } from "@/lib/types"
import { AbstractProvider } from "./base"
import { ProviderError } from "@/lib/blockchain/net"
import { getChainConfig, NATIVE_ASSET } from "@/lib/blockchain/config"
import {
  getBalanceViaRpc,
  getBlockTimestampViaRpc,
  getBlockNumberViaRpc,
  getLogsViaRpc,
  getTransactionViaRpc,
  type RpcLog,
} from "./evm-rpc"
import { normalizeNative, normalizeToken, baseUnitsToDecimal, directionOf, parseBlockHeight } from "@/lib/blockchain/normalize"
import {
  type DataSource,
  type PagedTokenTransfers,
  type PagedTransactions,
  type TokenTransfer,
  type TxQueryOptions,
  type WalletBalance,
} from "@/lib/blockchain/data-source"

// keccak256("Transfer(address,address,uint256)") — the ERC-20/BEP-20
// Transfer event topic0, identical on every EVM chain.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3e"

// eth_getLogs range every public node will actually serve without a 429/
// "range too large" rejection. Chosen conservatively; operators pointing at
// their own archive node still only get this window per call, but it keeps
// the raw-RPC contract honest and predictable across providers.
const LOG_SCAN_BLOCK_WINDOW = 50_000

function addressTopic(address: string): string {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0")
}

// Direct-node EVM adapter shared by Ethereum, Polygon, BSC, Arbitrum,
// Optimism, Base and Avalanche. No block-explorer/indexer API is used —
// every read is a JSON-RPC call against a public or operator-supplied node
// (see config.ts for the DIRECT-NODE ARCHITECTURE rationale).
export class EvmProvider extends AbstractProvider {
  readonly nativeSource: DataSource = "LIVE"

  constructor(readonly chain: Chain) {
    super()
  }

  get name(): string {
    return `evm-rpc:${this.chain}`
  }

  isConfigured(): boolean {
    return getChainConfig(this.chain).configured
  }

  private rpcUrl(): string {
    const cfg = getChainConfig(this.chain)
    if (!cfg.rpcUrl) throw new ProviderError(`${this.chain} has no RPC endpoint configured.`, "not_configured")
    return cfg.rpcUrl
  }

  // RPC-FIRST balance read (eth_getBalance) — works on every EVM chain with
  // zero configuration beyond the public node.
  async getWalletBalance(address: string): Promise<WalletBalance> {
    const wei = await getBalanceViaRpc(this.rpcUrl(), address)
    return {
      address,
      chain: this.chain,
      balance: baseUnitsToDecimal(wei, 18),
      asset: NATIVE_ASSET[this.chain],
      // No price data at this layer — null (never 0) means "unpriced".
      usdBalance: null,
    }
  }

  // Single-transaction lookup by hash — always answerable directly by any
  // node, no indexer required.
  async getTransaction(hash: string): Promise<Transaction | null> {
    const rpcUrl = this.rpcUrl()
    const tx = await getTransactionViaRpc(rpcUrl, hash)
    if (!tx) return null
    const timestamp = tx.blockNumber ? await getBlockTimestampViaRpc(rpcUrl, tx.blockNumber) : null
    return normalizeNative({
      hash,
      chain: this.chain,
      from: tx.from,
      to: tx.to ?? "",
      amount: baseUnitsToDecimal(tx.value, 18),
      asset: NATIVE_ASSET[this.chain],
      timestamp,
      blockHeight: parseBlockHeight(tx.blockNumber),
      provenance: "LIVE_BLOCKCHAIN_DATA",
      sourceType: "RAW_RPC",
    })
  }

  // Raw JSON-RPC has no "list every historical transaction touching this
  // address" call — that requires an indexer/archive service this adapter
  // deliberately does not use (see config.ts). Reporting this honestly as
  // an empty, explicitly-marked-unsupported result is the whole point of
  // the direct-node architecture: never fabricate a transaction history.
  async getTransactionsPaged(_address?: string, _chain?: Chain, _options?: TxQueryOptions): Promise<PagedTransactions> {
    return {
      transactions: [],
      meta: {
        totalFetched: 0,
        pagesFetched: 0,
        truncated: false,
        unsupported: true,
        unsupportedReason:
          `Native ${this.chain} transaction history cannot be listed from a raw JSON-RPC node — this requires an ` +
          `indexer/archive service, which this adapter does not use. Balance and single-transaction lookups are ` +
          `still fully live.`,
      },
    }
  }

  async getTransactions(address?: string, chain?: Chain, options?: TxQueryOptions): Promise<Transaction[]> {
    const { transactions } = await this.getTransactionsPaged(address, chain, options)
    return transactions
  }

  // ERC-20/BEP-20 transfer history IS something a raw node can answer
  // honestly via eth_getLogs — the Transfer event is emitted (and thus
  // indexed by the node's own log bloom filters) at mine time. The only
  // real constraint is the per-call block-range cap every public endpoint
  // enforces, so this scans backward from the chain head in bounded windows
  // until either the cap or maxPages (used here as "windows to scan") is hit.
  async getTokenTransfersPaged(address: string, _chain?: Chain, options: TxQueryOptions = {}): Promise<PagedTokenTransfers> {
    const rpcUrl = this.rpcUrl()
    const cap = Math.min(options.maxTransactions ?? 500, 500)
    const maxWindows = options.maxPages ?? 10

    const head = await getBlockNumberViaRpc(rpcUrl)
    const topic = addressTopic(address)

    const all: TokenTransfer[] = []
    let toBlock = head
    let windowsScanned = 0
    let truncated = false

    while (windowsScanned < maxWindows && toBlock > 0) {
      const fromBlock = Math.max(0, toBlock - LOG_SCAN_BLOCK_WINDOW + 1)
      windowsScanned++

      const [sent, received] = await Promise.all([
        getLogsViaRpc(rpcUrl, { topics: [TRANSFER_TOPIC, topic, null], fromBlock, toBlock }),
        getLogsViaRpc(rpcUrl, { topics: [TRANSFER_TOPIC, null, topic], fromBlock, toBlock }),
      ])
      const logs = [...sent, ...received].sort((a, b) => Number(BigInt(b.blockNumber)) - Number(BigInt(a.blockNumber)))

      for (const log of logs) {
        const transfer = await this.logToTokenTransfer(rpcUrl, address, log)
        if (transfer) all.push(transfer)
        if (all.length >= cap) break
      }

      if (all.length >= cap) {
        truncated = true
        break
      }
      toBlock = fromBlock - 1
    }

    if (toBlock > 0 && !truncated) truncated = true // stopped by maxWindows, not genesis

    return {
      transfers: all.slice(0, cap),
      meta: {
        totalFetched: all.length,
        pagesFetched: windowsScanned,
        truncated,
        unsupportedReason: truncated
          ? `Token-transfer history was scanned in ${LOG_SCAN_BLOCK_WINDOW.toLocaleString()}-block windows via eth_getLogs and capped at ${windowsScanned} window(s) from the current chain head — older transfers exist but were not scanned.`
          : undefined,
      },
    }
  }

  async getTokenTransfers(address: string, chain?: Chain, options?: TxQueryOptions): Promise<TokenTransfer[]> {
    const { transfers } = await this.getTokenTransfersPaged(address, chain, options)
    return transfers
  }

  private async logToTokenTransfer(rpcUrl: string, address: string, log: RpcLog): Promise<TokenTransfer | null> {
    if (log.topics.length < 3) return null
    const from = "0x" + log.topics[1].slice(-40)
    const to = "0x" + log.topics[2].slice(-40)
    let amountRaw: string
    try {
      amountRaw = BigInt(log.data).toString()
    } catch {
      return null
    }
    const timestamp = await getBlockTimestampViaRpc(rpcUrl, log.blockNumber)
    return {
      hash: log.transactionHash,
      chain: this.chain,
      from,
      to,
      // Decimals/symbol/name require an eth_call (decimals()/symbol()/name())
      // per unique token contract — deliberately not resolved here to avoid
      // an unbounded fan-out of extra RPC calls per log; the raw amount and
      // contract address are still fully honest, just unlabeled.
      tokenSymbol: "TOKEN",
      tokenName: "Unknown token (raw log — not resolved)",
      tokenAddress: log.address,
      amount: baseUnitsToDecimal(amountRaw, 18),
      decimals: 18,
      timestamp,
      blockHeight: parseBlockHeight(log.blockNumber),
      direction: directionOf(address, from, to),
      usdValue: null,
    }
  }
}

// Adapt a rich TokenTransfer into the common Transaction shape, reusing the
// shared normalizer instead of re-deriving field mapping per adapter.
export function evmTokenTransferToTransaction(t: TokenTransfer, referenceAddress?: string): Transaction {
  return normalizeToken({
    hash: t.hash,
    chain: t.chain,
    from: t.from,
    to: t.to,
    amount: t.amount,
    asset: t.tokenSymbol,
    tokenAddress: t.tokenAddress,
    timestamp: t.timestamp,
    blockHeight: t.blockHeight,
    address: referenceAddress,
    // Resolved directly from the node's own event log via eth_getLogs — no
    // third-party indexer involved, unlike the native-transaction case.
    sourceType: "RAW_RPC",
  })
}

// Named subclasses to match the required adapter architecture. Each binds the
// shared direct-RPC logic to a specific network.
export class EthereumProvider extends EvmProvider {
  constructor() {
    super("ethereum")
  }
}
export class PolygonProvider extends EvmProvider {
  constructor() {
    super("polygon")
  }
}
export class BSCProvider extends EvmProvider {
  constructor() {
    super("bsc")
  }
}

export class ArbitrumProvider extends EvmProvider {
  constructor() {
    super("arbitrum")
  }
}

export class OptimismProvider extends EvmProvider {
  constructor() {
    super("optimism")
  }
}

export class BaseProvider extends EvmProvider {
  constructor() {
    super("base")
  }
}

export class AvalancheProvider extends EvmProvider {
  constructor() {
    super("avalanche")
  }
}
