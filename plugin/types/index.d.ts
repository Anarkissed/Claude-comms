export type CommsChannelRow = {
  id: string
  agents: string[]
  /** The reviewer ids the maintainer can write to here (`reviewer` when the channel has the slot). */
  reviewers: string[]
  total: number
  unread: number
  pending: number
  skipped: number
  missing: boolean
}

export type CommsThreadItem = {
  id: string
  from: string
  to: string
  kind: string
  ts: string
  /** A preview of the body (the full text stays in the hooks module; state values stop at 4 MiB). */
  body: string
  /** The full body's length, in characters. */
  length: number
  pending: boolean
  /** Declined by the maintainer: the reason given (may be empty); null when not declined. */
  declined: string | null
  /** Put on hold by the maintainer (the sender was told); still pending. */
  held: boolean
  /** Not seen yet by the maintainer (not among the ids marked seen when the channel was last opened). */
  fresh: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agent-comms': {
      channels: CommsChannelRow[]
      threads: Record<string, CommsThreadItem[]>
      selected: string
      info: string
      /** The id of the waiting message whose decline box is open; empty when none. */
      declining: string
      /** Ids of long messages the maintainer expanded in full. */
      expanded: string[]
      /** How many of the newest messages are scrolled out of view below (0 = the latest is showing). */
      skip: number
      /** The message a tab click jumped to; drawn marked until the next jump. */
      focus: string
      /** channels.json's reviewer_mode: 'code' or 'chat'. */
      reviewerMode: string
      /** The main loop's running turn id; empty when the session is idle. Kept in state so a reload mid-turn knows. */
      turn: string
    }
  }
}
