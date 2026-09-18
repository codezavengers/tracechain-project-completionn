import { NextResponse } from "next/server"
import { ensureSeeded } from "@/lib/store"
import { requireUser } from "@/lib/api/session"
import { blockchain } from "@/lib/blockchain/service"
import { validateAddress } from "@/lib/blockchain/address-utils"
import { isDemoSource } from "@/lib/blockchain/data-source"
import { FundTracingEngine, ABSOLUTE_MAX_HOPS, DEFAULT_MAX_HOPS, type AttributionLookup } from "@/lib/engines/fund-tracing"
import type { Chain, DataProvenance } from "@/lib/types"

// Kept well below the case-investigation depth's own limits — this endpoint
// exists to chain several small lookups across hops, not to re-fetch a
// wallet's full history at every step.
const SEED_TX_LIMIT = 60
const HOP_TX_LIMIT = 40

// There is no verified, licensed address -> VASP mapping wired into this
// deployment. Inventing a plausible-sounding exchange label for a real,
// user-supplied address (even deterministically) would misrepresent a
// coincidence as an intelligence finding. Every counterparty is honestly
// reported as UNKNOWN until a real attribution feed is connected.
function makeAttributionLookup(_rootAddress: string): AttributionLookup {
  return () => null
}

export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  await ensureSeeded()
  const auth = await requireUser()
  if ("response" in auth) return auth.response

  const { address } = await params
  const url = new URL(req.url)
  const chainParam = url.searchParams.get("chain") as Chain | null
  const requestedHops = Number(url.searchParams.get("maxHops"))

  const validation = validateAddress(address, chainParam ?? undefined)
  if (!validation.valid || !validation.chain) {
    return NextResponse.json({ error: validation.reason ?? "Invalid address.", validation }, { status: 400 })
  }
  const chain = (chainParam && validation.candidateChains.includes(chainParam) ? chainParam : validation.chain) as Chain
  const maxHops = Number.isFinite(requestedHops) && requestedHops > 0 ? Math.min(ABSOLUTE_MAX_HOPS, Math.round(requestedHops)) : DEFAULT_MAX_HOPS

  const seed = await blockchain.getTransactions(address, chain, { maxTransactions: SEED_TX_LIMIT })
  const seedProvenance: DataProvenance = isDemoSource(seed.dataSource) ? "DEMO_DATA" : "LIVE_BLOCKCHAIN_DATA"

  const engine = new FundTracingEngine()
  const graph = await engine.trace({
    targetWallet: address,
    chain,
    transactions: seed.data,
    provenance: seedProvenance,
    maxHops,
    attributionFor: makeAttributionLookup(address),
    fetchNextHop: async (counterparty, c) => {
      const res = await blockchain.getTransactions(counterparty, c, { maxTransactions: HOP_TX_LIMIT })
      return {
        transactions: res.data,
        provenance: isDemoSource(res.dataSource) ? "DEMO_DATA" : "LIVE_BLOCKCHAIN_DATA",
      }
    },
  })

  return NextResponse.json({ validation, seedDataSource: seed.dataSource, graph })
}
