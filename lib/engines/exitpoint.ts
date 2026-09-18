import type { IntelResult, VaspAttribution, AttributionCategory } from "@/lib/types"
import type { AnalysisContext } from "./context"
import { nowIso, clamp, usd } from "./context"
import { VASP_KNOWLEDGE_BASE } from "@/lib/vasp/knowledge-base"

export interface ExitPoint {
  address: string
  usdValue: number
  inboundValue: number
  attribution: VaspAttribution
  isTerminal: boolean
}

export interface ExitPointResult {
  exitPoints: ExitPoint[]
  totalToExits: number
  probableVaspCount: number
}

// EXITPOINT AI: finds where funds most likely leave the traceable graph
// (exchange deposit endpoints, terminal high-value sinks).
export function runExitPoint(ctx: AnalysisContext): IntelResult<ExitPointResult> {
  const exits: ExitPoint[] = []

  for (const node of ctx.graph.nodes) {
    const inbound = ctx.graph.edges.filter((e) => e.target === node.id)
    const outbound = ctx.graph.edges.filter((e) => e.source === node.id)
    const inboundValue = inbound.reduce((s, e) => s + e.usdValue, 0)
    const isTerminal = outbound.length === 0 && inbound.length > 0

    const isExit = node.kind === "EXCHANGE" || (isTerminal && inboundValue > 0 && node.kind !== "VICTIM")
    if (!isExit) continue

    // Attribution is a behavioral pattern label only. There is no verified,
    // licensed address -> VASP mapping wired into this deployment, so a
    // specific named entity (e.g. "Binance") is NEVER assigned — doing so
    // from a deterministic pick would fabricate a real-world attribution
    // that was never actually confirmed. The category and reason describe
    // the observed deposit pattern; `vasp` stays undefined until a real
    // attribution feed is connected.
    let category: AttributionCategory = "UNKNOWN"
    const vasp = undefined
    let reason = "Terminal high-value sink with no observed onward movement."
    if (node.kind === "EXCHANGE") {
      category = "PROBABLE"
      reason = "Deposit-endpoint behavior consistent with a centralized exchange. Entity identity not verified — treat as PROBABLE exchange-pattern only."
    }

    const attribution: VaspAttribution = {
      category,
      vasp,
      confidence: category === "PROBABLE" ? 0.62 : 0.4,
      reason,
      provenance: category === "PROBABLE" ? "PROBABLE_ATTRIBUTION" : "HEURISTIC_ANALYSIS",
    }

    exits.push({
      address: node.id,
      usdValue: node.usdValue ?? inboundValue,
      inboundValue,
      attribution,
      isTerminal,
    })
  }

  exits.sort((a, b) => b.inboundValue - a.inboundValue)
  const totalToExits = exits.reduce((s, e) => s + e.inboundValue, 0)
  const probableVaspCount = exits.filter((e) => e.attribution.category === "PROBABLE").length

  const confidence = clamp(0.5 + probableVaspCount * 0.1 + (exits.length ? 0.1 : -0.2))

  return {
    result: { exitPoints: exits, totalToExits, probableVaspCount },
    confidence,
    explanation:
      "ExitPoint AI locates where funds most likely leave the traceable graph — exchange deposit endpoints and terminal value sinks — because these are the points where a KYC'd off-ramp or freeze request is actionable.",
    evidence: exits.length
      ? exits.map(
          (e) =>
            `${e.address.slice(0, 10)}… received ${usd(e.inboundValue)} — ${e.attribution.category} attribution${
              e.attribution.vasp ? ` (${e.attribution.vasp.name})` : ""
            }`,
        )
      : ["No clear exit endpoint identified within the current trace depth."],
    recommendation: probableVaspCount
      ? "Prepare VASP outreach for the highest-value probable exchange endpoints. Treat all attribution as PROBABLE pending verified intelligence."
      : "Extend trace depth or monitor terminal sinks for onward movement to an off-ramp.",
    analysisType: "graph",
    provenance: "HEURISTIC_ANALYSIS",
    generatedAt: nowIso(),
  }
}

export { VASP_KNOWLEDGE_BASE }
