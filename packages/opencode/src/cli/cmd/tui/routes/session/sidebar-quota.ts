type Msg = {
  role: string
  providerID?: string
  tokens?: {
    output?: number
  }
}

type Model = {
  providerID: string
  modelID: string
}

type Quota = {
  items: {
    label: string
    remaining: number | null
    limit: number | null
  }[]
  reset?: string
}

export function pickQuota(msgs: Msg[], current: Model | undefined, quota: Record<string, Quota | null>) {
  if (current?.providerID) {
    const result = quota[current.providerID]
    if (result) return result
  }

  const last = msgs.findLast((x) => x.role === "assistant" && (x.tokens?.output ?? 0) > 0)
  if (!last?.providerID) return
  return quota[last.providerID] ?? undefined
}
