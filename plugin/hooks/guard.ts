// The process guard's pure parts: which tool inputs to inspect, lexical path
// handling, and the spellings of the root a shell command may use.
// This is a process guard, not security: it stops a model from writing the
// comms folder by accident or by following a message's text. The robust half
// compares realPath against the root resolved the same way; the Bash half is a
// substring match on the command and is best effort (a `cd` earlier in the
// shell, a variable, an alias or a script file can hide the path).

/** Tools that only read, and this mod's own tools: never denied by the guard. */
export const EXEMPT_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'ToolSearch',
  'AskUserQuestion',
  'Agent',
  'Task',
  'SendMessage',
])

/** Input keys holding a path the tool will touch. */
export const PATH_KEYS = new Set([
  'file_path',
  'filePath',
  'path',
  'paths',
  'notebook_path',
  'directory',
  'dir',
  'cwd',
  'destination',
  'source',
  'target',
  'from',
  'to',
  'old_path',
  'new_path',
])

/** Input keys holding a shell command. */
export const COMMAND_KEYS = new Set(['command', 'cmd', 'script'])

/** Skills / slash commands only the person runs. */
export const PERSON_ONLY_COMMAND = /(^|[\s/:])comms(-as|-setup|-approve|-group)?(\s|$)/

/** Strings under `keys` anywhere in `input` (arrays and nested objects walked). */
export const stringsUnder = (input: unknown, keys: ReadonlySet<string>, depth = 0): string[] => {
  if (depth > 6 || typeof input !== 'object' || input === null) return []
  const found: string[] = []
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (keys.has(key)) {
      if (typeof value === 'string') found.push(value)
      if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') found.push(v)
    }
    if (typeof value === 'object' && value !== null) found.push(...stringsUnder(value, keys, depth + 1))
  }

  return found
}

/** `~` and `$HOME` expanded, made absolute under `cwd`, `.` and `..` folded. */
export const absolutize = (path: string, cwd: string, home: string): string => {
  let p = path.trim()
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1)
  p = p.replace(/^\$\{?HOME\}?(?=\/|$)/, home)
  if (!p.startsWith('/')) p = `${cwd.replace(/\/+$/, '')}/${p}`
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }

  return `/${out.join('/')}`
}

export const isInside = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

/** The spellings of the root a command may carry, longest first. */
export const rootSpellings = (roots: readonly string[], home: string): string[] => {
  const out = new Set<string>()
  for (const root of roots) {
    out.add(root)
    if (root.startsWith(`${home}/`)) {
      const rest = root.slice(home.length)
      out.add(`~${rest}`)
      out.add(`$HOME${rest}`)
      out.add(`\${HOME}${rest}`)
    }
    // the last two components (`me/agent-comms` for ~/agent-comms): a relative spelling
    const parts = root.split('/').filter(Boolean)
    if (parts.length >= 2) out.add(parts.slice(-2).join('/'))
  }

  return [...out].sort((a, b) => b.length - a.length)
}

/**
 * Whether a shell command names the root. Best effort: the root's spellings
 * anywhere in it, or the folder name as the start of a relative path
 * (`> agent-comms/channels/x`). A bare `rm -rf agent-comms` from the parent
 * folder is not caught: matching the bare word denied any command that merely
 * mentioned the name (a commit message, a README heading).
 */
export const commandMentionsRoot = (command: string, spellings: readonly string[], base: string): boolean => {
  if (spellings.some(s => command.includes(s))) return true
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return new RegExp(`(^|[\\s;&|(<>'"=])(\\./)?${escaped}/`).test(command)
}

export const denyText = (root: string): string =>
  `agent-comms: ${root} is written only through the comms tools. Use comms_post to send a message and comms_read to read yours; do not create, change, move or delete files there (approvals are the maintainer's, from the /comms pane).`
