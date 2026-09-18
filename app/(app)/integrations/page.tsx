"use client"

import useSWR from "swr"
import { Plug, KeyRound, Database, ShieldCheck } from "lucide-react"
import { SectionHeading, StatTile } from "@/components/intel/shared"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { LoadingBlock } from "@/components/ui/feedback"
import { fetcher } from "@/lib/client/hooks"
import { CHAIN_LABEL } from "@/lib/client/format"
import type { Chain, VaspRecord } from "@/lib/types"

interface ChainStatus {
  chain: Chain
  mode: "LIVE" | "DEMO"
  configured: boolean
  kind: "rpc" | "native-api" | "none"
  dataSource: "LIVE" | "INDEXED" | "CACHED" | "MOCK"
  dataSourceLabel: string
  envUrl: string
  envKey: string
  envUrlSet: boolean
  envKeySet: boolean
  requiresApiKeyForLive: boolean
  freeIndexerAvailable: boolean
}
interface IntegrationsData {
  chains: ChainStatus[]
  liveConfiguredCount: number
  vasps: VaspRecord[]
  jwtConfigured: boolean
}

const KIND_LABEL: Record<ChainStatus["kind"], string> = {
  rpc: "Direct JSON-RPC node",
  "native-api": "Native network API",
  none: "No adapter",
}

export default function IntegrationsPage() {
  const { data } = useSWR<IntegrationsData>("/api/integrations", fetcher)

  if (!data) return <LoadingBlock label="Loading integration status…" />

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <SectionHeading
        title="API Integrations"
        description="Blockchain provider configuration and the VASP reference knowledge base. Live mode is enabled per chain via environment variables — no keys are ever hardcoded or displayed."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Supported chains" value={data.chains.length} icon={Database} accent="var(--primary)" />
        <StatTile label="Live configured" value={data.liveConfiguredCount} accent="var(--risk-low)" />
        <StatTile label="Demo mode" value={data.chains.length - data.liveConfiguredCount} accent="var(--demo)" />
        <StatTile label="VASP records" value={data.vasps.length} icon={ShieldCheck} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plug className="size-4 text-primary" /> Blockchain providers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.chains.map((c) => (
            <div key={c.chain} className="rounded-md border border-border bg-background/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{CHAIN_LABEL[c.chain]}</span>
                  <Badge variant="muted" className="text-[10px]">
                    {KIND_LABEL[c.kind]}
                  </Badge>
                </div>
                <Badge
                  variant="outline"
                  style={{
                    color: c.mode === "LIVE" ? "var(--risk-low)" : "var(--demo)",
                    borderColor: `color-mix(in oklch, ${c.mode === "LIVE" ? "var(--risk-low)" : "var(--demo)"} 40%, transparent)`,
                  }}
                >
                  {c.dataSourceLabel}
                </Badge>
              </div>
              {c.freeIndexerAvailable && (
                <p className="mt-1.5 text-[11px] text-[var(--risk-low)]">
                  Live via a free, keyless public node — no API key required. Balance and single-transaction lookups
                  are fully live; native transaction history cannot be listed without an indexer (see below).
                </p>
              )}
              {c.requiresApiKeyForLive && (
                <p className="mt-1.5 text-[11px] text-[var(--demo)]">
                  No free, public, keyless node exists for this chain — set {c.envUrl} (and {c.envKey} if required) to
                  an operator-supplied node to enable LIVE mode.
                </p>
              )}
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                <EnvRow name={c.envUrl} set={c.envUrlSet} />
                <EnvRow name={c.envKey} set={c.envKeySet} />
              </div>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">
            No third-party block-explorer/indexer API is used anywhere in this path — every EVM/Bitcoin/Solana/TRON
            read is a direct JSON-RPC (or native network API) call, using a free public endpoint by default and an
            operator-supplied *_RPC_URL override when set. A raw node can always answer &quot;current balance&quot;
            and &quot;this one known transaction&quot;, but it genuinely cannot answer &quot;list every historical
            transaction for this address&quot; without an archive/indexing service — adapters report that limitation
            honestly instead of fabricating a transaction list. ERC-20/BEP-20 token-transfer history IS obtainable
            directly from a node via eth_getLogs and is scanned in bounded windows from the chain head. Results are
            briefly CACHED, and any chain without a working live source falls back to clearly-labelled MOCK demo data
            so the platform works offline.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" /> Security
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="flex items-center justify-between rounded-md border border-border bg-background/40 px-3 py-2">
            <span className="font-mono text-muted-foreground">TRACECHAIN_JWT_SECRET</span>
            <Badge variant={data.jwtConfigured ? "default" : "muted"}>
              {data.jwtConfigured ? "Configured" : "Using demo secret"}
            </Badge>
          </div>
          <p className="text-[11px] text-muted-foreground">
            JWT sessions are HS256-signed. Set a strong secret in production; the offline demo uses a clearly-labelled
            fallback secret.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" /> VASP knowledge base
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto scrollbar-thin rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Service</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Jurisdiction</th>
                  <th className="px-3 py-2 font-medium">KYC</th>
                  <th className="px-3 py-2 font-medium">Cooperation</th>
                </tr>
              </thead>
              <tbody>
                {data.vasps.map((v) => (
                  <tr key={v.id} className="border-b border-border/60 last:border-0 hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium text-foreground">{v.name}</td>
                    <td className="px-3 py-2">
                      <Badge variant="muted">{v.type}</Badge>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{v.jurisdiction}</td>
                    <td className="px-3 py-2 text-muted-foreground">{v.kycLevel}</td>
                    <td className="px-3 py-2 text-muted-foreground">{v.cooperationLevel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Reference list of publicly-known services for attribution heuristics only. This does NOT assert that any
            on-chain address is owned or operated by these entities.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function EnvRow({ name, set }: { name: string; set: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5">
      <span className="truncate font-mono text-[11px] text-muted-foreground">{name}</span>
      <span
        className="shrink-0 text-[10px] font-medium"
        style={{ color: set ? "var(--risk-low)" : "var(--muted-foreground)" }}
      >
        {set ? "SET" : "UNSET"}
      </span>
    </div>
  )
}
