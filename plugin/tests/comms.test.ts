import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { FsEntry, FsStat, On, ToolCallResult } from 'claude-code'

import { DEFAULT_CONFIG as PUBLIC_DEFAULT, format, formatApproval, isCandidateFile, newMessage, parse, type Kind } from '../hooks/format'

// ---- an in-memory world beneath the plugin ---------------------------------

// four agent channels, as a project with PRs 354, 358, 361 and 362 would have
const DEFAULT_CONFIG = {
  ...PUBLIC_DEFAULT,
  channels: ['358', '354', '361', '362'].map(id => ({ id, members: ['reviewer', id] })),
}
const WIN_ROOT = 'C:/Users/me/agent-comms'
const HOME = '/w' // so the default folder, HOME/agent-comms, is ROOT
const ROOT = '/w/agent-comms'
const CWD = '/w/proj'
/** Where the folder-loaded copy of the plugin kept its store. */
const OLD_STORE = `${HOME}/.claude/plugins/store/agent-comms_inline-f1bc9a6088a1.json`
const SID = 'S1'
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0, 0)

type World = {
  files: Map<string, string>
  writes: string[]
  /** For every $.fs.write: the candidate files then listed in that folder, and whether each parsed. */
  listedAtWrite: { dir: string; names: string[]; allParse: boolean }[]
  lists: string[]
  appended: string[]
  /** Every $.ui.log line (transcript notices). */
  logs: string[]
  /** Prompts the mod submitted to start a turn ($.prompt.submit). */
  prompts: string[]
  /** The test's clock: advancing it runs the mod's poll timer. */
  clock: MockClock
  status: () => string | undefined
  toasts: string[]
  tools: string[]
  links: Map<string, string>
  ran: string[][]
  put: (path: string, text: string) => void
  /** Folders the mod made (.keep markers). */
  keeps: Set<string>
  /** The plugin's $.store, as the test sees it. */
  store: Map<string, unknown>
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)

const world = (on: On, options: { identity?: string; config?: unknown; surfaces?: ('terminal' | 'desktop' | 'mobile' | 'vscode')[]; store?: Record<string, unknown>; windows?: true; host?: string; sid?: string } = {}): World => {
  const files = new Map<string, string>()
  const dirs = new Set<string>(['/', '/w', HOME, CWD, 'C:', 'C:/Users', 'C:/Users/me', 'C:/work'])
  const root = options.windows ? WIN_ROOT : ROOT
  const mtimes = new Map<string, number>()
  let tick = 1
  const addDirs = (p: string) => {
    for (let d = dirOf(p); d !== '/' && !dirs.has(d); d = dirOf(d)) dirs.add(d)
  }
  const put = (p: string, text: string) => {
    files.set(p, text)
    mtimes.set(p, (tick += 1))
    addDirs(p)
  }
  const links = new Map<string, string>()
  const real = (path: string) => {
    // this kit runs on macOS, where the engine reads C:/… as relative to the plugin's folder; on a PC it is absolute
    const drive = path.indexOf('/C:/')
    const p = drive >= 0 ? path.slice(drive + 1) : path
    for (const [link, target] of links) if (p === link || p.startsWith(`${link}/`)) return target + p.slice(link.length)
    return p
  }
  /** Folder markers (.keep), kept apart so tests that count messages do not count them. */
  const keeps = new Set<string>()
  const w: World = {
    files,
    writes: [],
    listedAtWrite: [],
    lists: [],
    appended: [],
    logs: [],
    prompts: [],
    clock: undefined as unknown as MockClock, // set just below
    status: () => statusText,
    toasts: [],
    tools: [],
    links,
    ran: [],
    put: (path, text) => put(path, text),
    keeps: undefined as unknown as Set<string>, // set just below
    store: new Map(), // filled just below
  }
  let statusText: string | undefined
  w.keeps = keeps

  if (options.config !== null) put(`${root}/channels.json`, JSON.stringify(options.config ?? DEFAULT_CONFIG))
  w.clock = mock.clock(on, { now: T0 })
  // the plugin's store, in memory, readable by the test (w.store)
  w.store = new Map(Object.entries({ ...(options.identity ? { [`identity:${SID}`]: options.identity } : {}), ...(options.store ?? {}) }))
  on('store.get', ($, e) => ({ value: w.store.has(e.key) ? JSON.parse(JSON.stringify(w.store.get(e.key))) : undefined }))
  on('store.set', ($, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  // the plugin reads only the home folder: USERPROFILE on Windows, HOME elsewhere
  const hostEnv = options.host ? { CLAUDE_CODE_HOST_SESSION_ID: options.host } : {}
  mock.env(on, options.windows ? { USERPROFILE: 'C:\\Users\\me', ...hostEnv } : { HOME, ...hostEnv })

  const listDir = (path: string): FsEntry[] => {
    const p = real(path)
    if (!dirs.has(p)) throw new Error(`ENOENT: ${path}`)
    const out: FsEntry[] = []
    for (const [f, text] of files) {
      if (dirOf(f) === p) out.push({ name: nameOf(f), kind: 'file', size: text.length, mtimeMs: mtimes.get(f) ?? 0, isLink: false })
    }
    for (const d of dirs) if (d !== p && dirOf(d) === p) out.push({ name: nameOf(d), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    return out
  }

  on('fs.read', ($, e) => {
    const text = files.get(real(e.path))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    if (e.path.endsWith('/.keep')) {
      keeps.add(real(e.path))
      addDirs(real(e.path))
      return { value: undefined }
    }
    const p = real(e.path)
    w.writes.push(p)
    put(p, e.text)
    const names = listDir(dirOf(p)).filter(x => x.kind === 'file' && isCandidateFile(x.name)).map(x => x.name)
    const allParse = names.every(n => n === 'channels.json' || parse(files.get(`${dirOf(p)}/${n}`) ?? '', n.slice(0, -5)).ok)
    w.listedAtWrite.push({ dir: dirOf(p), names, allParse })
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    w.lists.push(e.path)
    return { value: listDir(e.path) }
  })
  on('fs.exists', ($, e) => ({ value: files.has(real(e.path)) || dirs.has(real(e.path)) || keeps.has(real(e.path)) }))
  on('fs.stat', ($, e) => {
    const p = real(e.path)
    const isFile = files.has(p)
    if (!isFile && !dirs.has(p)) throw new Error(`ENOENT: ${e.path}`)
    const stat: FsStat = {
      kind: isFile ? 'file' : 'dir',
      size: files.get(p)?.length ?? 0,
      mtimeMs: mtimes.get(p) ?? 0,
      isLink: links.has(e.path),
      ...(e.resolve ? { realPath: p } : {}),
    }
    return { value: stat }
  })
  on('process.run', ($, e) => ({ value: { ...runCommand([...e.argv], e.init?.env ?? {}), isStdoutTruncated: false, isStderrTruncated: false } }))
  const runCommand = (argv: string[], env: Record<string, string>): { exitCode: number; stdout: string; stderr: string } => {
    w.ran.push(argv)
    const ok = { exitCode: 0, stdout: '', stderr: '' }
    if (argv[0] === '/bin/mv') {
      const [, flag, from, to] = argv
      if (from === undefined || to === undefined) return { ...ok, exitCode: 64 }
      const text = files.get(real(from))
      if (text === undefined) return { ...ok, exitCode: 1, stderr: 'no such file' }
      if (flag === '-n' && files.has(real(to))) return ok
      files.delete(real(from))
      put(real(to), text)
      return ok
    }
    if (argv[0] === '/bin/rm') {
      for (const p of argv.slice(2)) files.delete(real(p))
      return ok
    }
    if (argv[0] === '/bin/mkdir') {
      for (const p of argv.slice(2)) {
        addDirs(`${p}/x`)
      }
      return ok
    }
    if (argv[0] === 'powershell.exe') {
      const command = argv[argv.length - 1] ?? ''
      // the command text is fixed; the paths come in as environment variables
      const move = /^Move-Item -LiteralPath \$env:AGENT_COMMS_FROM -Destination \$env:AGENT_COMMS_TO( -Force)?$/.exec(command)
      if (move) {
        const from = env.AGENT_COMMS_FROM ?? '', to = env.AGENT_COMMS_TO ?? ''
        if (from === '' || to === '') return { ...ok, exitCode: 1, stderr: 'Cannot bind argument to parameter' }
        const text = files.get(real(from))
        if (text === undefined) return { ...ok, exitCode: 1, stderr: 'Cannot find path' }
        if (!move[1] && files.has(real(to))) return { ...ok, exitCode: 1, stderr: 'Cannot create a file when that file already exists.' }
        files.delete(real(from))
        put(real(to), text)
        return ok
      }
      const remove = /^Remove-Item -LiteralPath \$env:AGENT_COMMS_FROM -Force -ErrorAction SilentlyContinue$/.exec(command)
      if (remove) {
        files.delete(real(env.AGENT_COMMS_FROM ?? ''))
        return ok
      }
      return { ...ok, exitCode: 1, stderr: `unexpected PowerShell: ${command}` }
    }
    if (argv[0] === 'git') return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }
    return { ...ok, exitCode: 127 }
  }
  on('session.id', () => ({ value: options.sid ?? SID }))
  on('session.cwd', () => ({ value: options.windows ? 'C:\\work' : CWD }))
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('session.surfaces', () => ({ value: options.surfaces ?? ['desktop'] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', ($, e) => {
    statusText = e.text
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // each delivered message, as the conversation would keep it
  on('session.append', ($, e, next) => {
    const block = e.message.content[0]
    if (block !== undefined && typeof block === 'object' && 'text' in block) w.appended.push(String(block.text))
    return next(e)
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => {
    w.tools.push(e.name)
    return { value: { tool: `mcp__agent-comms__${e.name}` } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', () => ({ text: '' }))
  // the tools themselves, for calls the guard lets through
  on('tool.call', ($, e) => ({ result: `ran ${e.tool}` }))

  return w
}

const put = (w: World, path: string, text: string) => w.put(path, text)
const msgDir = (ch: string) => `${ROOT}/channels/${ch}/messages`
const apprDir = (ch: string) => `${ROOT}/channels/${ch}/approvals`

const PERSON = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
const PANE_PROPS = { title: 'agent-comms', isFocused: true, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} }

/** The channel rows of the maintainer's pane, as drawn on the terminal. */
const paneRows = async ($: Engine): Promise<string[]> => {
  const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'terminal', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
  const rows = (await ui.findAll({ type: 'Button' })).map(b => b.text).filter(t => t.startsWith('#'))
  const texts = [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Markdown' }))].map(t => t.text)
  await ui.unmount()
  return [...rows, ...texts]
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

const turn = async ($: Engine, n: number) => {
  await $.turn.start({ text: 'go', turnId: `t${n}` })
  for await (const _ of $.turn.step({ turnId: `t${n}`, index: 0, model: 'm', messageCount: 1 })) {
    // drain
  }
}

const denial = (r: ToolCallResult): string | undefined => r.deny ?? (r.isError ? String(r.text ?? r.result) : undefined)

const seedMessage = (w: World, ch: string, args: { from: string; to: string; kind?: Kind; body: string; at: number; hex: string }) => {
  const m = newMessage({ from: args.from, to: args.to, kind: args.kind ?? 'ruling', body: args.body, nowMs: args.at, hex: args.hex })
  put(w, `${msgDir(ch)}/${m.id}.json`, format(m))
  return m
}

// ---- 1. format / parse ----------------------------------------------------

describe('1. format and parse', () => {
  test('round trip, exact text, and rejection reasons', async () => {
    const m = newMessage({ from: '358', to: 'reviewer', kind: 'report', body: 'line one\n"quoted" ✓', nowMs: Date.UTC(2026, 9, 3, 12, 0, 0, 123), hex: 'a1b2c3' })
    expect(m.id).toBe('2026-10-03T12-00-00.123Z-358-a1b2c3')
    expect(format(m)).toBe(
      '{"v":1,"id":"2026-10-03T12-00-00.123Z-358-a1b2c3","from":"358","to":"reviewer","kind":"report","ts":"2026-10-03T12:00:00.123Z","body":"line one\\n\\"quoted\\" ✓"}\n',
    )
    const back = parse(format(m), m.id)
    expect(back).toEqual({ ok: true, message: m })
    expect(parse('{"v":1,', 'x')).toEqual({ ok: false, reason: 'not JSON' })
    expect(parse(format(m).replace('"v":1', '"v":2'), m.id)).toEqual({ ok: false, reason: 'wrong v (2)' })
    expect(parse(format(m), 'another-name')).toEqual({ ok: false, reason: 'id is not the file name' })
    expect(parse(format(m).replace('"report"', '"shout"'), m.id)).toEqual({ ok: false, reason: 'bad kind' })
  })

  test('a corrupt file and a wrong-v file are skipped and counted, never a crash', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const good = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'good', at: T0 - 3000, hex: '000001' })
    put(w, `${msgDir('358')}/2026-10-03T11-00-00.000Z-reviewer-bad001.json`, '{"v":1,"id":')
    const wrongV = newMessage({ from: 'reviewer', to: '358', kind: 'note', body: 'v2', nowMs: T0 - 2000, hex: 'bad002' })
    put(w, `${msgDir('358')}/${wrongV.id}.json`, format(wrongV).replace('"v":1', '"v":2'))
    await start($)
    const drawn = await paneRows($)
    expect(drawn).toContain('#358 · ⏳ 1 to approve · 1 new')
    expect(drawn).toContain('⚠ 2 unreadable files')
    expect(drawn).toContain('#354 · folder missing') // this world never made #354's folders
    expect(drawn.some(t => t === 'good')).toBe(true)
    expect(drawn.some(t => t === 'v2')).toBe(false)
    expect(good.body).toBe('good')
  })
})

// ---- 2. atomic write ------------------------------------------------------

describe('2. atomic write', () => {
  test('a message is written straight to its name with the file API; the plugin runs no program', async ($, on) => {
    const w = world(on, { identity: '358' })
    await start($)
    const posted = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: 'reviewer', kind: 'report', text: 'build is green' })
    expect(denial(posted)).toBeUndefined()
    const finals = [...w.files.keys()].filter(p => p.startsWith(msgDir('358')))
    expect(finals).toHaveLength(1)
    const messageWrites = w.writes.filter(p => p.startsWith(msgDir('358')))
    expect(messageWrites).toEqual(finals)
    expect(parse(w.files.get(finals[0] ?? '') ?? '', nameOf(finals[0] ?? '').slice(0, -5))).toMatchObject({ ok: true })
    expect(w.ran).toEqual([])
  })

  test('a message caught mid-write is read again once complete, and delivered', async ($, on) => {
    const w = world(on, { identity: '358' })
    const m = newMessage({ from: 'maintainer', to: '358', kind: 'note', body: 'finished writing', nowMs: T0 - 1000, hex: 'half01' })
    const text = format(m)
    put(w, `${msgDir('358')}/${m.id}.json`, text.slice(0, 20))
    await start($)
    await turn($, 1)
    expect(w.appended).toEqual([])
    put(w, `${msgDir('358')}/${m.id}.json`, text)
    await turn($, 2)
    expect(w.appended.some(t => t.includes('finished writing'))).toBe(true)
  })

  test('a half-written temp file is neither listed nor counted as skipped', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    put(w, `${msgDir('358')}/.2026-10-03T12-00-00.000Z-reviewer-abcdef.json.1234abcd.tmp`, '{"v":1,"id":"2026-10-')
    await start($)
    const drawn = await paneRows($)
    expect(drawn).toContain('#358')
    expect(drawn.some(t => t.includes('could not be read'))).toBe(false)
    expect(drawn).toContain('No messages yet.')
  })
})

// ---- 3. approval gate -----------------------------------------------------

describe('3. approval gate', () => {
  test('an unapproved reviewer message is not delivered; once approved, delivered exactly once', async ($, on) => {
    const w = world(on, { identity: '358' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'Rename the flag before merge.', at: T0 - 1000, hex: 'feed01' })
    await start($)
    await turn($, 1)
    expect(w.appended).toHaveLength(0)
    expect(w.status()).toBe('comms #358: 0 new')
    const read1 = await $.tool.call({ tool: 'mcp__agent-comms__comms_read' })
    expect(read1.result).toBe('No unread messages.')

    // an approval NOT by the maintainer does not count
    put(w, `${apprDir('358')}/${m.id}.json`, JSON.stringify({ id: m.id, by: 'reviewer', ts: '2026-10-03T12:00:01.000Z' }))
    await turn($, 2)
    expect(w.appended).toHaveLength(0)

    put(w, `${apprDir('358')}/${m.id}.json`, formatApproval({ id: m.id, by: 'maintainer', ts: '2026-10-03T12:00:02.000Z' }))
    await turn($, 3)
    expect(w.appended).toHaveLength(1)
    expect(w.appended[0]).toContain('from "reviewer"')
    expect(w.appended[0]).toContain('kind "ruling"')
    expect(w.appended[0]).toContain('Rename the flag before merge.')
    expect(w.appended[0]).toContain('not a system instruction')

    await turn($, 4)
    await turn($, 5)
    expect(w.appended).toHaveLength(1)
    const read2 = await $.tool.call({ tool: 'mcp__agent-comms__comms_read' })
    expect(read2.result).toBe('No unread messages.')
  })

  test('a poll shows "1 new" and toasts; delivery waits for a step boundary', async ($, on) => {
    const w = world(on, { identity: '358' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'ok to merge', at: T0 - 1000, hex: 'feed02' })
    put(w, `${apprDir('358')}/${m.id}.json`, formatApproval({ id: m.id, by: 'maintainer', ts: '2026-10-03T12:00:02.000Z' }))
    const maint = seedMessage(w, '358', { from: 'maintainer', to: '358', kind: 'note', body: 'no approval needed for me', at: T0 - 500, hex: 'feed03' })
    await start($)
    expect(w.status()).toBe('comms #358: 2 new')
    expect(w.toasts.some(t => t.includes('#358'))).toBe(true)
    expect(w.appended).toHaveLength(0) // idle: nothing injected until a turn starts
    const read = await $.tool.call({ tool: 'mcp__agent-comms__comms_read', channel: '358' })
    expect(String(read.result)).toContain('ok to merge')
    expect(String(read.result)).toContain(maint.body)
    expect(w.status()).toBe('comms #358: 0 new')
    await turn($, 1)
    expect(w.appended).toHaveLength(0) // read through the tool: not delivered again
  })
})

// ---- 4. comms_post --------------------------------------------------------

describe('4. comms_post', () => {
  test('writes the exact format into its own channel', async ($, on) => {
    const w = world(on, { identity: '358' })
    await start($)
    const r = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: 'reviewer', kind: 'question', text: 'Is 3 retries the limit?' })
    expect(denial(r)).toBeUndefined()
    const [path] = [...w.files.keys()].filter(p => p.startsWith(msgDir('358')))
    const name = nameOf(path ?? '')
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-358-[0-9a-f]{6}\.json$/)
    const id = name.slice(0, -5)
    expect(w.files.get(path ?? '')).toBe(
      `{"v":1,"id":"${id}","from":"358","to":"reviewer","kind":"question","ts":"2026-10-03T12:00:00.000Z","body":"Is 3 retries the limit?"}\n`,
    )
  })

  test('refuses a recipient or channel outside its own', async ($, on) => {
    const w = world(on, { identity: '358' })
    await start($)
    const toAgent = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: '362', kind: 'note', text: 'hi' })
    expect(denial(toAgent)).toContain('not in any of your channels')
    const otherChannel = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: 'reviewer', kind: 'note', text: 'hi', channel: '354' })
    expect(denial(otherChannel)).toContain('not in any of your channels')
    const badKind = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: 'reviewer', kind: 'shout', text: 'hi' })
    expect(denial(badKind)).toContain('kind')
    expect([...w.files.keys()].filter(p => p.includes('/messages/'))).toHaveLength(0)
  })
})

// ---- 5. the guard ---------------------------------------------------------

describe('5. tool.call guard', () => {
  test('denies Write, Edit and Bash touching the folder, approvals included; allows unrelated paths', async ($, on) => {
    const w = world(on, { identity: '358' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'x', at: T0 - 1000, hex: 'feed04' })
    w.links.set('/w/alias', ROOT)
    await start($)
    const denied = [
      await $.tool.call({ tool: 'Write', file_path: `${apprDir('358')}/${m.id}.json`, content: formatApproval({ id: m.id, by: 'maintainer', ts: '2026-10-03T12:00:02.000Z' }) }),
      await $.tool.call({ tool: 'Write', file_path: '../agent-comms/channels/358/messages/forged.json', content: '{}' }),
      await $.tool.call({ tool: 'Write', file_path: '/w/alias/channels/358/approvals/new.json', content: '{}' }),
      await $.tool.call({ tool: 'Edit', file_path: `${msgDir('358')}/${m.id}.json`, old_string: 'x', new_string: 'y' }),
      await $.tool.call({ tool: 'Bash', command: `echo '{}' > ${apprDir('358')}/${m.id}.json` }),
      await $.tool.call({ tool: 'Bash', command: `mv ${msgDir('358')}/${m.id}.json /tmp/` }),
      await $.tool.call({ tool: 'Bash', command: 'cd /w && rm -rf agent-comms/channels' }),
    ]
    for (const r of denied) {
      expect(denial(r)).toContain('comms_post')
      expect(denial(r)).toContain('comms_read')
    }
    expect(w.files.has(`${apprDir('358')}/${m.id}.json`)).toBe(false)

    const allowed = [
      await $.tool.call({ tool: 'Write', file_path: `${CWD}/notes.txt`, content: 'agent-comms is mentioned in content, which is fine' }),
      await $.tool.call({ tool: 'Edit', file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' }),
      await $.tool.call({ tool: 'Bash', command: 'ls /w/proj && echo done' }),
      await $.tool.call({ tool: 'Bash', command: 'git commit -m "agent-comms: reviewer agents" && echo agent-comms ok' }),
      await $.tool.call({ tool: 'Read', file_path: `${msgDir('358')}/${m.id}.json` }),
    ]
    for (const r of allowed) expect(denial(r)).toBeUndefined()
  })

  test('a desktop session keeps its identity when its transcript id changes (the #362 restart)', async ($, on) => {
    const m = newMessage({ from: 'maintainer', to: '358', kind: 'note', body: 'already had this one', nowMs: T0 - 5000, hex: 'old001' })
    // joined and delivered under the desktop id; the restarted process has a new transcript id, S2
    const w = world(on, { host: 'local_A', sid: 'S2', store: { 'identity:local_A': '358', 'delivered:local_A:358': [m.id] } })
    put(w, `${msgDir('358')}/${m.id}.json`, format(m))
    await start($)
    await turn($, 1)
    expect(w.tools).toContain('comms_post')
    expect(w.appended.some(t => t.includes('already had this one'))).toBe(false)
  })

  test('records kept under the transcript id move to the desktop id, and nothing is delivered twice', async ($, on) => {
    const m = newMessage({ from: 'maintainer', to: '358', kind: 'note', body: 'delivered before the move', nowMs: T0 - 5000, hex: 'old002' })
    const w = world(on, { host: 'local_A', store: { [`identity:${SID}`]: '358', [`delivered:${SID}:358`]: [m.id] } })
    put(w, `${msgDir('358')}/${m.id}.json`, format(m))
    await start($)
    await turn($, 1)
    expect(w.tools).toContain('comms_post')
    expect(w.appended.some(t => t.includes('delivered before the move'))).toBe(false)
    expect(w.store.get('identity:local_A')).toBe('358')
    expect(w.store.has(`identity:${SID}`)).toBe(false)
    expect(w.store.get('delivered:local_A:358')).toEqual([m.id])
  })

  test('/comms-as <agent> in a restarted session takes over its earlier record: nothing is sent twice', async ($, on) => {
    const m = newMessage({ from: 'maintainer', to: '358', kind: 'note', body: 'seen by the earlier session', nowMs: T0 - 5000, hex: 'old003' })
    const w = world(on, { host: 'local_B', store: { 'identity:OLD': '358', 'delivered:OLD:358': [m.id], 'woken:OLD': [m.id] } })
    put(w, `${msgDir('358')}/${m.id}.json`, format(m))
    await start($)
    const joined = await $.command.run({ command: 'comms-as', args: '358', ...PERSON })
    expect(joined.text).toContain('this session is 358')
    await turn($, 1)
    expect(w.appended.some(t => t.includes('seen by the earlier session'))).toBe(false)
    expect(w.store.has('identity:OLD')).toBe(false)
    expect(w.store.get('delivered:local_B:358')).toContain(m.id)
  })

  test('installed from a marketplace, a session takes its records from the folder-loaded store: same identity, nothing sent twice', async ($, on) => {
    const m = newMessage({ from: 'maintainer', to: '358', kind: 'note', body: 'delivered by the folder-loaded copy', nowMs: T0 - 5000, hex: 'imp001' })
    const w = world(on, { host: 'local_A' })
    put(w, `${msgDir('358')}/${m.id}.json`, format(m))
    put(w, OLD_STORE, JSON.stringify({ 'identity:local_A': '358', 'delivered:local_A:358': [m.id], 'identity:local_Z': '361', 'held:maintainer': ['x'] }))
    await start($)
    await turn($, 1)
    expect(w.tools).toContain('comms_post')
    expect(w.appended.some(t => t.includes('delivered by the folder-loaded copy'))).toBe(false)
    // another session's identity stays in the old file until that session moves over
    expect(w.store.has('identity:local_Z')).toBe(false)
  })

  test('the store import never brings back an identity the session gave up', async ($, on) => {
    const w = world(on, { host: 'local_A', store: { 'imported:local_A': true } })
    put(w, OLD_STORE, JSON.stringify({ 'identity:local_A': '358' }))
    await start($)
    await turn($, 1)
    expect(w.tools).not.toContain('comms_post')
    expect(w.store.has('identity:local_A')).toBe(false)
  })

  test('/comms-as <agent> also takes over an earlier session recorded only in the folder-loaded store (the #362 case)', async ($, on) => {
    const m = newMessage({ from: 'maintainer', to: '358', kind: 'note', body: 'seen long ago', nowMs: T0 - 5000, hex: 'imp002' })
    const w = world(on, { host: 'local_A', sid: 'S9' })
    put(w, `${msgDir('358')}/${m.id}.json`, format(m))
    put(w, OLD_STORE, JSON.stringify({ 'identity:OLDEST': '358', 'delivered:OLDEST:358': [m.id] }))
    await start($)
    const joined = await $.command.run({ command: 'comms-as', args: '358', ...PERSON })
    expect(joined.text).toContain('this session is 358')
    await turn($, 1)
    expect(w.appended.some(t => t.includes('seen long ago'))).toBe(false)
  })

  test('the Comms folder setting places the folder; HOME/agent-comms is only the default', { options: { folder: '/w/elsewhere' } }, async ($, on) => {
    const w = world(on, { identity: '358' })
    put(w, '/w/elsewhere/channels.json', JSON.stringify(DEFAULT_CONFIG))
    await start($)
    const posted = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: 'reviewer', kind: 'note', text: 'moved' })
    expect(denial(posted)).toBeUndefined()
    expect([...w.files.keys()].some(p => p.startsWith('/w/elsewhere/channels/358/messages/'))).toBe(true)
    expect([...w.files.keys()].some(p => p.startsWith(`${msgDir('358')}/`))).toBe(false)
  })

  test('a command typed as agent-comms:<name> is answered the same as the plain name', async ($, on) => {
    world(on)
    const plain = await $.command.run({ command: 'comms-as', args: '', ...PERSON })
    const spaced = await $.command.run({ command: 'agent-comms:comms-as', args: '', ...PERSON })
    expect(plain.text).toContain('not joined')
    expect(spaced.text).toBe(plain.text)
    const joined = await $.command.run({ command: 'agent-comms:comms-as', args: '358', ...PERSON })
    expect(joined.text).toContain('this session is 358')
  })

  test('the model cannot run the person-only commands through the Skill tool', async ($, on) => {
    world(on, { identity: '358' })
    await start($)
    const r = await $.tool.call({ tool: 'Skill', skill: 'comms-as', args: 'maintainer' })
    expect(denial(r)).toContain('run by the person')
  })
})

// ---- 6. identity ----------------------------------------------------------

describe('6. identity', () => {
  test('/comms-as off: the session stops polling and receiving, its tools refuse', async ($, on) => {
    const w = world(on, { identity: '358' })
    const m = seedMessage(w, '358', { from: 'maintainer', to: '358', kind: 'note', body: 'arrives after leaving', at: T0 - 1000, hex: 'off001' })
    await start($)
    expect(w.status()).toBe('comms #358: 1 new')
    const left = await $.command.run({ command: 'comms-as', args: 'off', ...PERSON })
    expect(left.text).toContain('no longer 358')
    expect(w.status()).toBe('comms: off (/comms-as <id> to join)')
    const listed = w.lists.length
    await turn($, 1)
    await turn($, 2)
    expect(w.appended).toEqual([])
    expect(w.lists.length).toBe(listed)
    const read = await $.tool.call({ tool: 'mcp__agent-comms__comms_read' })
    expect(denial(read)).toContain('has not joined')
    const post = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: 'reviewer', kind: 'note', text: 'hi' })
    expect(denial(post)).toContain('has not joined')
    const shown = await $.command.run({ command: 'comms-as', args: '', ...PERSON })
    expect(shown.text).toContain('not joined')
    // rejoining picks the message up again
    await $.command.run({ command: 'comms-as', args: '358', ...PERSON })
    await turn($, 3)
    // the waiting note, and #358's setup note written by the rejoin
    expect(w.appended).toHaveLength(2)
    expect(w.appended.some(t => t.includes(m.body))).toBe(true)
    expect(w.appended.some(t => t.includes('[agent-comms setup] Channel #358'))).toBe(true)
  })

  test('unset: inert apart from the status line', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, 1)
    expect(w.status()).toBe('comms: not joined (/comms-as <id>)')
    expect(w.tools).toEqual([])
    // it never polls the comms folder (the one look at the old store folder is the import)
    expect(w.lists.filter(p => p.startsWith(ROOT))).toEqual([])
    expect(w.appended).toEqual([])
    expect(w.ran).toEqual([])
  })

  test('set: sees only its own channels', async ($, on) => {
    const w = world(on)
    seedMessage(w, '354', { from: 'maintainer', to: '354', kind: 'note', body: 'for 354 only', at: T0 - 1000, hex: 'feed05' })
    await start($)
    const joined = await $.command.run({ command: 'comms-as', args: '358', ...PERSON })
    expect(joined.text).toContain('this session is 358')
    expect(w.tools).toEqual(['comms_read', 'comms_post'])
    const touched = w.lists.filter(p => p.startsWith(`${ROOT}/channels/`))
    expect(touched.length).toBeGreaterThan(0)
    for (const p of touched) expect(p.startsWith(`${ROOT}/channels/358/`)).toBe(true)
    // joining wrote #358's setup note (it had none): its one unread message
    expect(w.status()).toBe('comms #358: 1 new')
    const r = await $.tool.call({ tool: 'mcp__agent-comms__comms_read', channel: '354' })
    expect(denial(r)).toContain('not a member')
    const all = await $.tool.call({ tool: 'mcp__agent-comms__comms_read' })
    expect(String(all.result)).toContain('[agent-comms setup] Channel #358')
    expect(String(all.result)).not.toContain('for 354 only')
    expect(w.status()).toBe('comms #358: 0 new')
    const typo = await $.command.run({ command: 'comms-as', args: 'revewer', ...PERSON })
    expect(typo.text).toBe('"revewer" looks like a typo: did you mean /comms-as reviewer?')
    const typo2 = await $.command.run({ command: 'comms-as', args: 'maintaner', ...PERSON })
    expect(typo2.text).toContain('did you mean /comms-as maintainer?')
  })
})

describe('6b. registering a new agent with /comms-as', () => {
  test('a new PR number gets its own channel, folders and setup note; joining again adds nothing', async ($, on) => {
    const w = world(on)
    await start($)
    const joined = await $.command.run({ command: 'comms-as', args: '363', ...PERSON })
    expect(joined.text).toContain('this session is 363')
    expect(joined.text).toContain('Registered 363')
    const cfg = JSON.parse(w.files.get(`${ROOT}/channels.json`) ?? '{}')
    expect(cfg.channels).toEqual([...DEFAULT_CONFIG.channels, { id: '363', members: ['reviewer', '363'] }])
    expect(cfg.require_approval).toBe(true)
    expect(cfg.poll_seconds).toBe(15)
    expect(w.keeps.has(`${msgDir('363')}/.keep`) && w.keeps.has(`${apprDir('363')}/.keep`)).toBe(true)
    const notes = [...w.files.entries()].filter(([p]) => p.startsWith(`${msgDir('363')}/`))
    expect(notes).toHaveLength(1)
    const note = parse(notes[0]?.[1] ?? '', nameOf(notes[0]?.[0] ?? '').slice(0, -5))
    expect(note.ok && note.message).toMatchObject({ from: 'maintainer', to: '363', kind: 'note' })
    expect(w.tools).toEqual(['comms_read', 'comms_post'])
    for (const path of w.lists.filter(p => p.startsWith(`${ROOT}/channels/`))) expect(path.startsWith(`${ROOT}/channels/363/`)).toBe(true)
    expect(w.status()).toBe('comms #363: 1 new')

    const again = await $.command.run({ command: 'comms-as', args: '363', ...PERSON })
    expect(again.text).not.toContain('Registered')
    expect(JSON.parse(w.files.get(`${ROOT}/channels.json`) ?? '{}').channels).toHaveLength(5)
    expect([...w.files.keys()].filter(p => p.startsWith(`${msgDir('363')}/`))).toHaveLength(1)
  })

  test('an existing agent keeps channels.json as it is; a typo is refused and changes nothing', async ($, on) => {
    const w = world(on)
    await start($)
    const before = w.files.get(`${ROOT}/channels.json`)
    const reserved = await $.command.run({ command: 'comms-as', args: 'all', ...PERSON })
    expect(reserved.text).toContain('not an id this session can take')
    const known = await $.command.run({ command: 'comms-as', args: '358', ...PERSON })
    expect(known.text).not.toContain('Registered')
    expect(w.files.get(`${ROOT}/channels.json`)).toBe(before)
    expect(w.ran.some(a => a[0] === '/bin/mv' && a[3] === `${ROOT}/channels.json`)).toBe(false)
    expect(w.keeps.has(`${msgDir('358')}/.keep`)).toBe(true)
  })

  test('before /comms-setup a new id is not registered and nothing is created', async ($, on) => {
    const w = world(on, { config: null })
    await start($)
    const r = await $.command.run({ command: 'comms-as', args: '363', ...PERSON })
    expect(r.text).toContain('not set up yet')
    expect(w.files.size).toBe(0)
    expect(w.ran).toEqual([])
  })
})

describe('6c. named reviewers (Reviewer3)', () => {
  test('a named reviewer joins every channel with a reviewer slot, without touching channels.json', async ($, on) => {
    const w = world(on)
    await start($)
    const before = w.files.get(`${ROOT}/channels.json`)
    const joined = await $.command.run({ command: 'comms-as', args: 'Reviewer3', ...PERSON })
    expect(joined.text).toContain('this session is Reviewer3')
    expect(joined.text).toContain('Reviewer in #358, #354, #361, #362')
    expect(w.files.get(`${ROOT}/channels.json`)).toBe(before)
    expect([...w.files.keys()].filter(p => p.includes('/messages/'))).toHaveLength(0)
    expect(w.tools).toEqual(['comms_read', 'comms_post'])
    const posted = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: '358', kind: 'ruling', text: 'Split the PR.' })
    expect(denial(posted)).toBeUndefined()
    const [path] = [...w.files.keys()].filter(p => p.startsWith(`${msgDir('358')}/`))
    expect(nameOf(path ?? '')).toContain('-Reviewer3-')
    const plain = await $.command.run({ command: 'comms-as', args: 'reviewer', ...PERSON })
    expect(plain.text).toContain('this session is reviewer')
  })

  test('a named reviewer\'s message waits for approval; the agent can answer it; the answer needs none', async ($, on) => {
    const w = world(on, { identity: '358' })
    const m = seedMessage(w, '358', { from: 'Reviewer3', to: '358', body: 'Split the PR.', at: T0 - 1000, hex: 'rev301' })
    await start($)
    await turn($, 1)
    expect(w.appended).toHaveLength(0)
    put(w, `${apprDir('358')}/${m.id}.json`, formatApproval({ id: m.id, by: 'maintainer', ts: '2026-10-03T12:00:02.000Z' }))
    await turn($, 2)
    expect(w.appended).toHaveLength(1)
    expect(w.appended[0]).toContain('from "Reviewer3"')
    expect(w.appended[0]).toContain('Approved by the maintainer')
    const reply = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: 'Reviewer3', kind: 'answer', text: 'Splitting now.' })
    expect(denial(reply)).toBeUndefined()
    const replyPath = [...w.files.keys()].find(p => p.startsWith(`${msgDir('358')}/`) && p.includes('-358-'))
    const parsed = parse(w.files.get(replyPath ?? '') ?? '', nameOf(replyPath ?? '').slice(0, -5))
    expect(parsed.ok && parsed.message).toMatchObject({ from: '358', to: 'Reviewer3', kind: 'answer' })
  })

  test('the reviewer reads agents\' answers without approval; the maintainer sees its messages as awaiting', async ($, on) => {
    const w = world(on, { identity: 'Reviewer3' })
    seedMessage(w, '358', { from: '358', to: 'Reviewer3', kind: 'question', body: 'Which flag name?', at: T0 - 2000, hex: 'rev302' })
    seedMessage(w, '354', { from: 'Reviewer3', to: '354', body: 'pending ruling', at: T0 - 1000, hex: 'rev303' })
    await start($)
    // addressed to the cloud reviewer, not by name: not reviewer3's
    seedMessage(w, '361', { from: '361', to: 'reviewer', kind: 'question', body: 'for the cloud reviewer', at: T0 - 1500, hex: 'rev305' })
    const read = await $.tool.call({ tool: 'mcp__agent-comms__comms_read' })
    expect(String(read.result)).toContain('Which flag name?')
    expect(String(read.result)).not.toContain('for the cloud reviewer')
    expect(String(read.result)).toContain('Delivered by agent-comms.')
  })
})

describe('6e. the plain reviewer moves from one chat to the next', () => {
  test('a new session takes "reviewer" and receives what the old one had; agents write to "reviewer"', async ($, on) => {
    const w = world(on)
    seedMessage(w, '358', { from: '358', to: 'reviewer', kind: 'question', body: 'earlier question', at: T0 - 2000, hex: 'mov001' })
    await start($)
    const joined = await $.command.run({ command: 'comms-as', args: 'reviewer', ...PERSON })
    expect(joined.text).toContain('this session is reviewer')
    expect(joined.text).toContain('Reviewer in #358, #354, #361, #362')
    await turn($, 1)
    expect(w.appended.some(t => t.includes('earlier question'))).toBe(true)
    const posted = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: '358', kind: 'ruling', text: 'Go ahead.' })
    expect(denial(posted)).toBeUndefined()
    const left = await $.command.run({ command: 'comms-as', args: 'off', ...PERSON })
    expect(left.text).toContain('no longer reviewer')
  })
})

describe('6d. the maintainer approves a named reviewer', () => {
  test('a Reviewer3 message counts as awaiting approval in the pane', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const m = seedMessage(w, '354', { from: 'Reviewer3', to: '354', body: 'pending ruling', at: T0 - 1000, hex: 'rev304' })
    await start($)
    expect(w.status()).toBe('comms: 1 awaiting approval (/comms)')
    const drawn = await paneRows($)
    expect(drawn).toContain('#354 · ⏳ 1 to approve · 1 new')
    expect(m.from).toBe('Reviewer3')
  })
})

// ---- the maintainer's pane ------------------------------------------------

describe('maintainer pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: Approve writes the approval file, Hold leaves it pending, the box posts as maintainer`, async ($, on) => {
      const w = world(on, { identity: 'maintainer' })
      const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: `ruling for ${surface}`, at: T0 - 1000, hex: surface === 'terminal' ? 'aaaa01' : 'aaaa02' })
      await start($)
      expect(w.status()).toBe('comms: 1 awaiting approval (/comms)')
      const opened = await $.command.run({ command: 'comms', args: '', ...PERSON })
      expect(opened.text).toBe('agent-comms pane opened.')
      const ui = await $.ui.mount({ plugin: 'agent-comms', surface, component: 'Pane', requestId: 'comms', props: PANE_PROPS })
      expect(await ui.find({ type: 'Text', text: /Waiting for your approval/ })).toBeDefined()
      expect(await ui.find({ type: 'Markdown', text: `ruling for ${surface}` })).toBeDefined()
      await ui.press({ key: `hold:${m.id}` })
      expect(w.files.has(`${apprDir('358')}/${m.id}.json`)).toBe(false)
      await ui.press({ key: `approve:${m.id}` })
      const approval = w.files.get(`${apprDir('358')}/${m.id}.json`)
      expect(approval).toBe(`{"id":"${m.id}","by":"maintainer","ts":"2026-10-03T12:00:00.000Z"}\n`)
      expect(w.status()).toBe('comms (maintainer): nothing awaiting approval')
      await ui.input({ key: 'post:358:358', text: 'answer: yes, go ahead' })
      // the maintainer's post to 358 (Hold also sent 358 a note, checked below)
      const posted = [...w.files.entries()].filter(([p, text]) => p.startsWith(msgDir('358')) && p.includes('-maintainer-') && !text.includes('On hold:'))
      expect(posted).toHaveLength(1)
      const holdNotes = [...w.files.entries()].filter(([p, text]) => p.startsWith(msgDir('358')) && text.includes('On hold:'))
      expect(holdNotes).toHaveLength(2) // one to the reviewer, one to 358
      const parsed = parse(posted[0]?.[1] ?? '', nameOf(posted[0]?.[0] ?? '').slice(0, -5))
      expect(parsed.ok && parsed.message).toMatchObject({ from: 'maintainer', to: '358', kind: 'answer', body: 'yes, go ahead' })
      await ui.unmount()
    })
  }
})

describe('maintainer pane on the mobile app', () => {
  test('mobile: the chat draws and Approve works; there is no text box (the app draws no Input)', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: '**Split** the PR.', at: T0 - 1000, hex: 'mob001' })
    await start($)
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'mobile', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    expect(await ui.find({ type: 'Markdown', text: '**Split** the PR.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Waiting for your approval/ })).toBeDefined()
    expect(await ui.find({ type: 'Input' })).toBeUndefined()
    await ui.press({ key: `approve:${m.id}` })
    expect(w.files.has(`${apprDir('358')}/${m.id}.json`)).toBe(true)
    await ui.unmount()
  })
})

describe('pane round 3: setup notes, writing to the reviewer, the phone', () => {
  const setupNote = (w: World, ch: string) => {
    const body = `[agent-comms setup] Channel #${ch}: members reviewer, ${ch}. Each message is one JSON file ... {"v": 1}`
    const m = newMessage({ from: 'maintainer', to: ch, kind: 'note', body, nowMs: T0 - 5000, hex: 'set001' })
    put(w, `${msgDir(ch)}/${m.id}.json`, format(m))
  }

  test('a setup note is one quiet line, not the JSON guide', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    setupNote(w, '358')
    await start($)
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'desktop', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /Channel set up · the format guide was sent to 358/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /JSON/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the maintainer writes to the reviewer from the pane; it needs no approval', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    await start($)
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'desktop', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    await ui.input({ key: 'post:358:reviewer', text: 'question: is 358 ready to merge?' })
    const [entry] = [...w.files.entries()].filter(([p]) => p.startsWith(`${msgDir('358')}/`))
    const parsed = parse(entry?.[1] ?? '', nameOf(entry?.[0] ?? '').slice(0, -5))
    expect(parsed.ok && parsed.message).toMatchObject({ from: 'maintainer', to: 'reviewer', kind: 'question', body: 'is 358 ready to merge?' })
    expect(w.status()).toBe('comms (maintainer): nothing awaiting approval')
    await ui.unmount()
  })

  test('with a phone attached, /comms also replies with the conversations and approval codes', async ($, on) => {
    const w = world(on, { identity: 'maintainer', surfaces: ['desktop', 'mobile'] })
    setupNote(w, '358')
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'Split the PR.', at: T0 - 1000, hex: 'c0de01' })
    await start($)
    const r = await $.command.run({ command: 'comms', args: '', ...PERSON })
    expect(r.text).toContain('agent-comms pane opened.')
    expect(r.text).toContain('**#358** · ⏳ 1 waiting for your approval')
    expect(r.text).toContain('> Split the PR.')
    expect(r.text).toContain('`/comms-approve c0de01`')
    expect(r.text).not.toContain('format guide')
    expect(r.text).not.toContain('JSON')
    const ok = await $.command.run({ command: 'comms-approve', args: 'c0de01', ...PERSON })
    expect(ok.text).toBe('✓ Approved: reviewer\'s ruling to 358 on #358.')
    expect(w.files.get(`${apprDir('358')}/${m.id}.json`)).toBe(`{"id":"${m.id}","by":"maintainer","ts":"2026-10-03T12:00:00.000Z"}\n`)
    const again = await $.command.run({ command: 'comms-approve', args: 'c0de01', ...PERSON })
    expect(again.text).toContain('no message is waiting')
    const bad = await $.command.run({ command: 'comms-approve', args: 'zz', ...PERSON })
    expect(bad.text).toContain('6-character code')
  })

  test('on desktop alone, /comms only opens the pane', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'Split the PR.', at: T0 - 1000, hex: 'c0de02' })
    await start($)
    const r = await $.command.run({ command: 'comms', args: '', ...PERSON })
    expect(r.text).toBe('agent-comms pane opened.')
  })

  test('only the maintainer approves by code, and never the model', async ($, on) => {
    const w = world(on, { identity: '358' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'x', at: T0 - 1000, hex: 'c0de03' })
    await start($)
    const r = await $.command.run({ command: 'comms-approve', args: 'c0de03', ...PERSON })
    expect(r.text).toContain('maintainer')
    const skill = await $.tool.call({ tool: 'Skill', skill: 'comms-approve', args: 'c0de03' })
    expect(denial(skill)).toContain('run by the person')
    expect(w.files.has(`${apprDir('358')}/${m.id}.json`)).toBe(false)
  })
})

describe('phone notices in the transcript', () => {
  test('with a phone attached, a waiting reviewer message and a message to the maintainer each get one notice line', async ($, on) => {
    const w = world(on, { identity: 'maintainer', surfaces: ['desktop', 'mobile'] })
    seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'Split the PR.\nDetails follow.', at: T0 - 2000, hex: 'ab0001' })
    seedMessage(w, '354', { from: '354', to: 'maintainer', kind: 'question', body: 'Can I merge?', at: T0 - 1000, hex: 'ab0002' })
    await start($)
    expect(w.logs).toEqual([
      '📨 #358 · reviewer → 358 · ⚖️ ruling: "Split the PR." · approve: /comms-approve ab0001',
      '📨 #354 · 354 → maintainer · ❓ question: "Can I merge?"',
    ])
    // later scans (and a reload, which keeps the store) do not announce them again
    await $.command.run({ command: 'comms', args: '', ...PERSON })
    await start($)
    expect(w.logs).toHaveLength(2)
  })

  test('on desktop alone: a toast, no transcript line', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'Split the PR.', at: T0 - 2000, hex: 'ab0003' })
    await start($)
    expect(w.logs).toEqual([])
    expect(w.toasts).toContain("comms #358: reviewer's ruling awaits your approval (/comms)")
  })
})

describe('Hold and Decline', () => {
  const mount = ($: Engine, surface: 'terminal' | 'desktop' = 'desktop') =>
    $.ui.mount({ plugin: 'agent-comms', surface, component: 'Pane', requestId: 'comms', props: PANE_PROPS })
  const notesTo = (w: World, ch: string, to: string) =>
    [...w.files.entries()]
      .filter(([p]) => p.startsWith(`${msgDir(ch)}/`) && p.includes('-maintainer-'))
      .map(([p, text]) => parse(text, nameOf(p).slice(0, -5)))
      .flatMap(r => (r.ok && r.message.to === to ? [r.message] : []))

  test('Hold tells the reviewer and the agent, once, to expect a message soon; the message stays pending', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'Split the PR into two.', at: T0 - 1000, hex: 'h01d01' })
    await start($)
    const ui = await mount($)
    await ui.press({ key: `hold:${m.id}` })
    const notes = notesTo(w, '358', '358')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toBe('On hold: a ruling from reviewer to you is on hold with the maintainer and has not been delivered yet. Expect a message from the maintainer soon.')
    expect(notesTo(w, '358', 'reviewer').map(n => n.body)).toEqual([
      'On hold: your ruling to 358 ("Split the PR into two.") is on hold with the maintainer and has not been delivered yet. Expect a message from the maintainer soon.',
    ])
    expect(await ui.find({ type: 'Text', text: /On hold · reviewer and 358 were told/ })).toBeDefined()
    expect(await ui.find({ key: `hold:${m.id}` })).toBeUndefined()
    expect(w.files.has(`${apprDir('358')}/${m.id}.json`)).toBe(false)
    expect(w.status()).toBe('comms: 1 awaiting approval (/comms)')
    // still approvable after a hold
    await ui.press({ key: `approve:${m.id}` })
    expect(w.files.has(`${apprDir('358')}/${m.id}.json`)).toBe(true)
    await ui.unmount()
  })

  for (const surface of ['terminal', 'desktop'] as const) test(`${surface}: Decline opens a box; the reason goes to the reviewer only, never the agent; the text is never delivered`, async ($, on) => {
    {
      const w = world(on, { identity: 'maintainer' })
      const m = seedMessage(w, '354', { from: 'reviewer', to: '354', body: 'Rewrite the parser.', at: T0 - 1000, hex: surface === 'terminal' ? 'dec001' : 'dec002' })
      await start($)
      const ui = await mount($, surface)
      await ui.press({ key: 'ch:354' }) // the pane opens on #358
      expect(await ui.find({ key: `decline:${m.id}` })).toBeUndefined()
      await ui.press({ key: `decline-open:${m.id}` })
      expect(await ui.find({ key: `decline:${m.id}` })).toBeDefined()
      await ui.input({ key: `decline:${m.id}`, text: 'Too big for this PR; open an issue instead.' })
      const record = w.files.get(`${ROOT}/channels/354/declined/${m.id}.json`)
      expect(record).toBe(`{"id":"${m.id}","by":"maintainer","ts":"2026-10-03T12:00:00.000Z","reason":"Too big for this PR; open an issue instead."}\n`)
      // the agent is told nothing: no note to it, nothing addressed to everyone
      expect(notesTo(w, '354', '354')).toEqual([])
      expect(notesTo(w, '354', 'all')).toEqual([])
      expect(notesTo(w, '354', 'reviewer').map(n => n.body)).toEqual([
        'Declined: your ruling to 354 ("Rewrite the parser.") was not delivered, and 354 was not told.\nReason: Too big for this PR; open an issue instead.',
      ])
      expect(await ui.find({ type: 'Text', text: /declined: Too big for this PR/ })).toBeDefined()
      expect(await ui.find({ key: `approve:${m.id}` })).toBeUndefined()
      expect(w.status()).toBe('comms (maintainer): nothing awaiting approval')
      expect(w.files.has(`${apprDir('354')}/${m.id}.json`)).toBe(false)
      const code = await $.command.run({ command: 'comms-approve', args: m.id.slice(-6), ...PERSON })
      expect(code.text).toContain('no message is waiting')
      await ui.unmount()
    }
  })

  test('Cancel closes the decline box without declining', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'x', at: T0 - 1000, hex: 'dec003' })
    await start($)
    const ui = await mount($)
    await ui.press({ key: `decline-open:${m.id}` })
    await ui.press({ key: `cancel:${m.id}` })
    expect(await ui.find({ key: `decline:${m.id}` })).toBeUndefined()
    expect(await ui.find({ key: `approve:${m.id}` })).toBeDefined()
    expect([...w.files.keys()].some(p => p.includes('/declined/'))).toBe(false)
    await ui.unmount()
  })

  test('an agent never receives a declined message', async ($, on) => {
    const w = world(on, { identity: '358' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'declined ruling', at: T0 - 1000, hex: 'dec004' })
    put(w, `${ROOT}/channels/358/declined/${m.id}.json`, `{"id":"${m.id}","by":"maintainer","ts":"2026-10-03T12:00:01.000Z","reason":"no"}\n`)
    await start($)
    await turn($, 1)
    expect(w.appended.some(t => t.includes('declined ruling'))).toBe(false)
  })
})

describe('reviewer messages to the maintainer', () => {
  test('need no approval: no buttons, nothing counted as waiting, and no note to the maintainer', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: 'maintainer', kind: 'note', body: 'Reviewer here, test.', at: T0 - 1000, hex: 'r2m001' })
    await start($)
    expect(w.status()).toBe('comms (maintainer): nothing awaiting approval')
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'desktop', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    expect(await ui.find({ key: `approve:${m.id}` })).toBeUndefined()
    expect(await ui.find({ key: `hold:${m.id}` })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /could not be read/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /approved/ })).toBeUndefined()
    await ui.unmount()
    expect([...w.files.keys()].filter(p => p.includes('-maintainer-'))).toHaveLength(0)
  })
})

describe('reviewer fix list (#358 testing)', () => {
  const notes = (w: World, ch: string) =>
    [...w.files.entries()]
      .filter(([p]) => p.startsWith(`${msgDir(ch)}/`) && p.includes('-maintainer-'))
      .map(([p, text]) => parse(text, nameOf(p).slice(0, -5)))
      .flatMap(r => (r.ok ? [r.message] : []))

  test('1. Approve/Hold/Decline only on a reviewer message to an agent', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const toAgent = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'to the agent', at: T0 - 2000, hex: 'fx0001' })
    const toYou = seedMessage(w, '358', { from: 'reviewer', to: 'maintainer', kind: 'note', body: 'to you', at: T0 - 1000, hex: 'fx0002' })
    await start($)
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'desktop', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    for (const key of ['approve', 'hold', 'decline-open']) {
      expect(await ui.find({ key: `${key}:${toAgent.id}` })).toBeDefined()
      expect(await ui.find({ key: `${key}:${toYou.id}` })).toBeUndefined()
    }
    await ui.unmount()
  })

  test('2. Hold never writes a maintainer -> maintainer message', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', kind: 'question', body: 'held one', at: T0 - 1000, hex: 'fx0003' })
    await start($)
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'desktop', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    await ui.press({ key: `hold:${m.id}` })
    await ui.unmount()
    expect(notes(w, '358').filter(n => n.to === 'maintainer')).toEqual([])
    expect([...w.files.keys()].some(p => nameOf(p).endsWith('.tmp'))).toBe(false)
  })

  test('3. the notes use the right article ("an answer", "a ruling")', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const answer = seedMessage(w, '358', { from: 'reviewer', to: '358', kind: 'question', body: 'q', at: T0 - 2000, hex: 'fx0004' })
    put(w, `${msgDir('358')}/${answer.id}.json`, format({ ...answer, kind: 'answer' }))
    await start($)
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'desktop', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    await ui.press({ key: `hold:${answer.id}` })
    await ui.unmount()
    const toAgent = notes(w, '358').find(n => n.to === '358')
    expect(toAgent?.body).toContain('On hold: an answer from reviewer to you')
    expect(notes(w, '358').some(n => / a answer/.test(n.body))).toBe(false)
  })

  test('4. a held message shows "held", a waiting one "waiting", in the pane', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const first = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'first', at: T0 - 2000, hex: 'fx0005' })
    const second = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'second', at: T0 - 1000, hex: 'fx0006' })
    await start($)
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'desktop', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    await ui.press({ key: `hold:${first.id}` })
    expect(await ui.findAll({ type: 'Text', text: /⏸ On hold/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /⏳ Waiting for your approval/ })).toHaveLength(1)
    expect(await ui.find({ key: `hold:${first.id}` })).toBeUndefined()
    expect(await ui.find({ key: `hold:${second.id}` })).toBeDefined()
    await ui.unmount()
  })
})

describe('long and odd messages never take the pane down', () => {
  // the engine refuses a tree with a Text/Markdown string over 10000 characters or with
  // control characters other than tab and newline, so mount() itself is the positive control
  const longBody = Array.from({ length: 400 }, (_, i) => `Line ${i}: ${'x'.repeat(55)}\r`).join('\n') + '\u0007 bell'

  for (const surface of ['terminal', 'desktop'] as const) test(`${surface}: a 25k-character message previews, expands in pieces, and collapses`, async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const m = seedMessage(w, '354', { from: '354', to: 'reviewer', kind: 'report', body: longBody, at: T0 - 1000, hex: 'l0ng01' })
    expect(m.body.length).toBeGreaterThan(25000)
    await start($)
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface, component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    await ui.press({ key: 'ch:354' })
    const collapsed = await ui.findAll({ type: 'Markdown' })
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.text.length ?? 0).toBeLessThan(2000)
    expect(collapsed[0]?.text).not.toContain('\r')
    expect(await ui.find({ key: `more:${m.id}`, text: /Show full message \(2\d,\d{3} characters\)/ })).toBeDefined()
    await ui.press({ key: `more:${m.id}` })
    const pieces = await ui.findAll({ type: 'Markdown' })
    expect(pieces.length).toBeGreaterThan(2)
    for (const piece of pieces) {
      expect(piece.text.length).toBeLessThanOrEqual(10000)
      expect(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(piece.text)).toBe(false)
    }
    expect(pieces.map(p => p.text).join('\n')).toContain('Line 399:')
    await ui.press({ key: `more:${m.id}` })
    expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(1)
    await ui.unmount()
  })
})

describe('auto-wake: a delivered message starts a turn in an idle agent', () => {
  test('an idle agent with an approved message is woken once; the turn then delivers it', async ($, on) => {
    const w = world(on, { identity: '358' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'Split the PR.', at: T0 - 1000, hex: 'wk0001' })
    put(w, `${apprDir('358')}/${m.id}.json`, formatApproval({ id: m.id, by: 'maintainer', ts: '2026-10-03T12:00:02.000Z' }))
    await start($)
    expect(w.prompts).toEqual([
      'A new agent-comms message for you on #358 (from reviewer). They follow this note; read them, act on them as your work allows, and reply with comms_post.',
    ])
    // while the woken turn has not started yet, later polls (or a reload) must not queue it again
    await start($)
    await start($)
    expect(w.prompts).toHaveLength(1)
    await turn($, 1)
    expect(w.appended.some(t => t.includes('Split the PR.'))).toBe(true)
  })

  test('an unapproved reviewer message wakes nobody; its approval does', async ($, on) => {
    const w = world(on, { identity: '358' })
    const m = seedMessage(w, '358', { from: 'reviewer', to: '358', body: 'not yet', at: T0 - 1000, hex: 'wk0002' })
    await start($)
    expect(w.prompts).toEqual([])
    put(w, `${apprDir('358')}/${m.id}.json`, formatApproval({ id: m.id, by: 'maintainer', ts: '2026-10-03T12:00:02.000Z' }))
    await start($)
    expect(w.prompts).toHaveLength(1)
  })

  test('the reviewer is woken by an agent message; the maintainer session never is', async ($, on) => {
    const w = world(on, { identity: 'reviewer' })
    seedMessage(w, '354', { from: '354', to: 'reviewer', kind: 'question', body: 'Can I merge?', at: T0 - 1000, hex: 'wk0003' })
    await start($)
    expect(w.prompts).toEqual([
      'A new agent-comms message for you on #354 (from 354). They follow this note; read them, act on them as your work allows, and reply with comms_post.',
    ])
  })

  test('the maintainer session is never woken', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    seedMessage(w, '354', { from: '354', to: 'maintainer', kind: 'question', body: 'For you', at: T0 - 1000, hex: 'wk0004' })
    await start($)
    expect(w.prompts).toEqual([])
  })

  test('"auto_wake": false in channels.json turns it off', async ($, on) => {
    const w = world(on, { identity: '358', config: { ...DEFAULT_CONFIG, auto_wake: false } })
    seedMessage(w, '358', { from: 'maintainer', to: '358', kind: 'note', body: 'quiet', at: T0 - 1000, hex: 'wk0005' })
    await start($)
    expect(w.prompts).toEqual([])
    expect(w.status()).toBe('comms #358: 1 new')
  })

  test('a session in a running turn is not woken; it gets the message at its next step', async ($, on) => {
    const w = world(on, { identity: '358' })
    await start($)
    await $.turn.start({ text: 'working', turnId: 't1' }) // a turn is running
    seedMessage(w, '358', { from: 'maintainer', to: '358', kind: 'note', body: 'mid-turn note', at: T0 - 1000, hex: 'wk0006' })
    await w.clock.advance(15_000) // the poll timer scans mid-turn
    expect(w.status()).toBe('comms #358: 1 new')
    expect(w.prompts).toEqual([])
    for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 2 })) {
      // drain
    }
    expect(w.appended.some(t => t.includes('mid-turn note'))).toBe(true)
    // a prompt submitted mid-turn would be held by the engine and surface once the turn ends
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(w.prompts).toEqual([])
  })
})

describe('pane header stays put; tabs jump to the new message', () => {
  const many = (w: World, ch: string, n: number, fromAt = T0 - 100_000) => {
    const out: ReturnType<typeof newMessage>[] = []
    for (let i = 0; i < n; i += 1) {
      out.push(seedMessage(w, ch, { from: i % 2 === 0 ? ch : 'maintainer', to: i % 2 === 0 ? 'reviewer' : ch, kind: 'note', body: `message ${i}`, at: fromAt + i * 1000, hex: `a${String(i).padStart(5, '0')}` }))
    }
    return out
  }
  const mount = ($: Engine) => $.ui.mount({ plugin: 'agent-comms', surface: 'desktop', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
  const bodies = async (ui: Awaited<ReturnType<typeof mount>>) => (await ui.findAll({ type: 'Markdown' })).map(m => m.text)

  test('the header (title, summary, tabs) is drawn whatever the scroll; the wheel moves only the messages', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    many(w, '358', 12)
    await start($)
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: '📬 agent-comms' })).toBeDefined()
    expect(await bodies(ui)).toContain('message 11')
    expect(await ui.find({ key: 'latest' })).toBeUndefined()
    // the person scrolls all the way up (Home: by = minus the content's rows)
    await $.ui.scroll({ component: 'Pane', requestId: 'comms', offset: 0, by: -200, bodyRows: 60, contentRows: 60, origin: { kind: 'person' } })
    expect(await ui.find({ type: 'Text', text: '📬 agent-comms' })).toBeDefined()
    expect(await ui.find({ key: 'ch:358' })).toBeDefined()
    expect(await bodies(ui)).not.toContain('message 11')
    expect(await bodies(ui)).toContain('message 0')
    expect(await ui.find({ key: 'latest', text: /newer messages · jump to latest/ })).toBeDefined()
    await ui.press({ key: 'latest' })
    expect(await bodies(ui)).toContain('message 11')
    expect(await ui.find({ key: 'latest' })).toBeUndefined()
    await ui.unmount()
  })

  test('a tab with "new" jumps to its first new message and marks it', async ($, on) => {
    // the maintainer had seen everything up to the last old message (message 9, hex a00009)
    const lastOld = newMessage({ from: 'maintainer', to: '354', kind: 'note', body: 'message 9', nowMs: T0 - 100_000 + 9000, hex: 'a00009' })
    const w = world(on, { identity: 'maintainer', store: { 'seen:maintainer:354': lastOld.id } })
    const old = many(w, '354', 10)
    expect(old[9]?.id).toBe(lastOld.id)
    seedMessage(w, '354', { from: '354', to: 'maintainer', kind: 'question', body: 'first new one', at: T0 - 2000, hex: 'new001' })
    seedMessage(w, '354', { from: '354', to: 'maintainer', kind: 'question', body: 'second new one', at: T0 - 1000, hex: 'new002' })
    await start($)
    const ui = await mount($)
    expect(await ui.find({ key: 'ch:354', text: '#354 · 2 new' })).toBeDefined()
    await ui.press({ key: 'ch:354' })
    const drawn = await bodies(ui)
    expect(drawn[drawn.length - 1]).toBe('first new one') // brought to it: the window ends on it
    expect(drawn).not.toContain('second new one')
    expect(await ui.find({ type: 'Text', text: /▶ new/ })).toBeDefined()
    expect(await ui.find({ key: 'latest', text: /1 newer message · jump to latest/ })).toBeDefined()
    expect(await ui.find({ key: 'ch:354', text: '#354' })).toBeDefined() // seen now
    await ui.unmount()
  })

  test('an approval says who and what in words, not the file id', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    const m = seedMessage(w, '362', { from: 'reviewer', to: '362', body: 'go', at: T0 - 1000, hex: 'apr001' })
    await start($)
    const ui = await mount($)
    await ui.press({ key: 'ch:362' })
    await ui.press({ key: `approve:${m.id}` })
    expect(await ui.find({ type: 'Text', text: "✓ Approved reviewer's ruling to 362; it reaches 362 at its next step." })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /apr001/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('group chats (several agents and the reviewer)', () => {
  const TEAM = { ...DEFAULT_CONFIG, channels: [...DEFAULT_CONFIG.channels, { id: 'team', members: ['reviewer', '354', '358'] }] }
  const groupFiles = (w: World) =>
    [...w.files.entries()]
      .filter(([p]) => p.startsWith(`${msgDir('team')}/`))
      .map(([p, text]) => parse(text, nameOf(p).slice(0, -5)))
      .flatMap(r => (r.ok ? [r.message] : []))

  test('/comms-group adds the group, its folders and one setup note to everyone; it refuses bad input', async ($, on) => {
    const w = world(on, { identity: 'maintainer' })
    await start($)
    const made = await $.command.run({ command: 'comms-group', args: 'team 354 358', ...PERSON })
    expect(made.text).toBe('Group #team is ready: reviewer, 354, 358. Messages to "all" reach everyone in it; each agent sees it beside its own channel.')
    const cfg = JSON.parse(w.files.get(`${ROOT}/channels.json`) ?? '{}')
    expect(cfg.channels).toEqual([...DEFAULT_CONFIG.channels, { id: 'team', members: ['reviewer', '354', '358'] }])
    expect(w.keeps.has(`${msgDir('team')}/.keep`) && w.keeps.has(`${apprDir('team')}/.keep`)).toBe(true)
    const notes = groupFiles(w)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ from: 'maintainer', to: 'all', kind: 'note' })
    expect(notes[0]?.body).toContain('[agent-comms setup] Group #team')
    // again with the same agents: nothing more
    expect((await $.command.run({ command: 'comms-group', args: 'team 358 354', ...PERSON })).text).toContain('is ready')
    expect(groupFiles(w)).toHaveLength(1)
    expect((await $.command.run({ command: 'comms-group', args: 'team 354 361', ...PERSON })).text).toContain('already exists')
    expect((await $.command.run({ command: 'comms-group', args: '777 354 358', ...PERSON })).text).toContain("can't be a group name")
    expect((await $.command.run({ command: 'comms-group', args: 'solo 354', ...PERSON })).text).toContain('at least two agents')
    expect(JSON.parse(w.files.get(`${ROOT}/channels.json`) ?? '{}').channels).toHaveLength(5)
  })

  test('an agent\'s message to "all" reaches the other agent without approval, not its sender', async ($, on) => {
    const w = world(on, { identity: '354', config: TEAM })
    seedMessage(w, 'team', { from: '358', to: 'all', kind: 'report', body: 'parser PR is up', at: T0 - 2000, hex: 'grp001' })
    seedMessage(w, 'team', { from: '354', to: 'all', kind: 'report', body: 'my own report', at: T0 - 1000, hex: 'grp002' })
    await start($)
    await turn($, 1)
    expect(w.appended.some(t => t.includes('parser PR is up') && t.includes('to everyone in group #team'))).toBe(true)
    expect(w.appended.some(t => t.includes('my own report'))).toBe(false)
    expect(w.status()).toContain('comms #team: 0 new')
  })

  test('the reviewer\'s message to "all" waits for approval; one approval delivers it to every agent', async ($, on) => {
    for (const agent of ['354']) {
      const w = world(on, { identity: agent, config: TEAM })
      const m = seedMessage(w, 'team', { from: 'reviewer', to: 'all', body: 'Freeze the API until Friday.', at: T0 - 1000, hex: 'grp003' })
      await start($)
      await turn($, 1)
      expect(w.appended.some(t => t.includes('Freeze the API'))).toBe(false)
      put(w, `${apprDir('team')}/${m.id}.json`, formatApproval({ id: m.id, by: 'maintainer', ts: '2026-10-03T12:00:02.000Z' }))
      await turn($, 2)
      expect(w.appended.some(t => t.includes('Freeze the API'))).toBe(true)
      break // one world per test; the second agent is the next test
    }
  })

  test('…and 358 receives the same approved group message', async ($, on) => {
    const w = world(on, { identity: '358', config: TEAM })
    const m = seedMessage(w, 'team', { from: 'reviewer', to: 'all', body: 'Freeze the API until Friday.', at: T0 - 1000, hex: 'grp003' })
    put(w, `${apprDir('team')}/${m.id}.json`, formatApproval({ id: m.id, by: 'maintainer', ts: '2026-10-03T12:00:02.000Z' }))
    await start($)
    await turn($, 1)
    expect(w.appended.some(t => t.includes('Freeze the API'))).toBe(true)
  })

  test('comms_post to "all" writes into the group; with no group it is refused', async ($, on) => {
    const w = world(on, { identity: '354', config: TEAM })
    await start($)
    const ok = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: 'all', kind: 'question', text: 'Who owns the API client?' })
    expect(denial(ok)).toBeUndefined()
    expect(groupFiles(w).some(m => m.from === '354' && m.to === 'all' && m.body === 'Who owns the API client?')).toBe(true)
  })

  test('an agent in no group cannot post to "all"', async ($, on) => {
    world(on, { identity: '361', config: TEAM })
    await start($)
    const r = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: 'all', kind: 'note', text: 'hi' })
    expect(denial(r)).toContain('you are in no such group')
  })

  test('Decline on a group message tells only the reviewer; no agent in the group is told', async ($, on) => {
    const w = world(on, { identity: 'maintainer', config: TEAM })
    const m = seedMessage(w, 'team', { from: 'reviewer', to: 'all', body: 'Freeze the API.', at: T0 - 1000, hex: 'grp009' })
    await start($)
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'desktop', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    await ui.press({ key: 'ch:team' })
    await ui.press({ key: `decline-open:${m.id}` })
    await ui.input({ key: `decline:${m.id}`, text: 'Not yet.' })
    const notes = groupFiles(w).filter(n => n.from === 'maintainer')
    expect(notes.map(n => n.to)).toEqual(['reviewer'])
    expect(notes[0]?.body).toContain('Reason: Not yet.')
    await ui.unmount()
  })

  test('Hold on a group message sends ONE note to the group; the pane offers "to everyone"', async ($, on) => {
    const w = world(on, { identity: 'maintainer', config: TEAM })
    const m = seedMessage(w, 'team', { from: 'reviewer', to: 'all', body: 'Freeze the API.', at: T0 - 1000, hex: 'grp004' })
    await start($)
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'desktop', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    await ui.press({ key: 'ch:team' })
    expect(await ui.find({ key: 'post:team:all' })).toBeDefined()
    await ui.press({ key: `hold:${m.id}` })
    const notes = groupFiles(w).filter(n => n.from === 'maintainer')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ to: 'all' })
    expect(notes[0]?.body).toContain('On hold: a ruling from reviewer to the group')
    await ui.input({ key: 'post:team:all', text: 'answer: noted, thanks' })
    expect(groupFiles(w).some(n => n.from === 'maintainer' && n.to === 'all' && n.kind === 'answer')).toBe(true)
    await ui.unmount()
  })

  test('the model cannot run /comms-group', async ($, on) => {
    world(on, { identity: '354' })
    await start($)
    const r = await $.tool.call({ tool: 'Skill', skill: 'comms-group', args: 'x 1 2' })
    expect(denial(r)).toContain('run by the person')
  })
})

describe('reviewer as a Code session or a Chat agent; any agent name; #direct', () => {
  const WITH_DIRECT = { ...DEFAULT_CONFIG, channels: [...DEFAULT_CONFIG.channels, { id: 'direct', members: ['reviewer', 'maintainer'] }] }

  test('reviewer_mode "code": a Code session holding reviewer is woken by any message to it', async ($, on) => {
    const w = world(on, { identity: 'reviewer', config: { ...WITH_DIRECT, reviewer_mode: 'code' } })
    seedMessage(w, 'direct', { from: 'maintainer', to: 'reviewer', kind: 'question', body: 'Status of 358?', at: T0 - 1000, hex: 'rm0001' })
    await start($)
    expect(w.prompts).toHaveLength(1)
    await turn($, 1)
    expect(w.appended.some(t => t.includes('Status of 358?'))).toBe(true)
  })

  test('reviewer_mode "chat": the same message is delivered at its next step but wakes nobody', async ($, on) => {
    const w = world(on, { identity: 'reviewer', config: { ...WITH_DIRECT, reviewer_mode: 'chat' } })
    seedMessage(w, 'direct', { from: 'maintainer', to: 'reviewer', kind: 'question', body: 'Status of 358?', at: T0 - 1000, hex: 'rm0002' })
    await start($)
    expect(w.prompts).toEqual([])
    const joined = await $.command.run({ command: 'comms-as', args: 'reviewer', ...PERSON })
    expect(joined.text).toContain('reviewer_mode "chat"')
  })

  test('#direct: the maintainer and the reviewer alone; no approval either way; agents never see it', async ($, on) => {
    const w = world(on, { identity: 'maintainer', config: WITH_DIRECT })
    seedMessage(w, 'direct', { from: 'reviewer', to: 'maintainer', kind: 'answer', body: 'All four PRs reviewed.', at: T0 - 1000, hex: 'dir001' })
    await start($)
    expect(w.status()).toBe('comms (maintainer): nothing awaiting approval')
    const ui = await $.ui.mount({ plugin: 'agent-comms', surface: 'desktop', component: 'Pane', requestId: 'comms', props: PANE_PROPS })
    await ui.press({ key: 'ch:direct' })
    expect(await ui.find({ type: 'Text', text: /#direct \(you\) ↔ reviewer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reviewer: Code session/ })).toBeDefined()
    expect(await ui.find({ key: 'post:direct:reviewer' })).toBeDefined()
    expect(await ui.find({ key: 'post:direct:all' })).toBeUndefined()
    await ui.input({ key: 'post:direct:reviewer', text: 'question: anything blocking?' })
    const mine = [...w.files.entries()].filter(([p, t]) => p.startsWith(`${msgDir('direct')}/`) && t.includes('"from":"maintainer"'))
    expect(mine).toHaveLength(1)
    await ui.unmount()
  })

  test('an agent does not see #direct', async ($, on) => {
    const w = world(on, { identity: '358', config: WITH_DIRECT })
    seedMessage(w, 'direct', { from: 'maintainer', to: 'reviewer', kind: 'note', body: 'private', at: T0 - 1000, hex: 'dir002' })
    await start($)
    expect(w.lists.some(p => p.includes('/channels/direct/'))).toBe(false)
    const r = await $.tool.call({ tool: 'mcp__agent-comms__comms_read', channel: 'direct' })
    expect(denial(r)).toContain('not a member')
  })

  test('any agent name works, not only PR numbers; reserved ones are refused', async ($, on) => {
    const w = world(on, { config: WITH_DIRECT })
    await start($)
    const joined = await $.command.run({ command: 'comms-as', args: 'frontend', ...PERSON })
    expect(joined.text).toContain('Registered frontend')
    expect(JSON.parse(w.files.get(`${ROOT}/channels.json`) ?? '{}').channels.at(-1)).toEqual({ id: 'frontend', members: ['reviewer', 'frontend'] })
    expect((await $.command.run({ command: 'comms-as', args: 'direct', ...PERSON })).text).toContain('not an id this session can take')
    expect((await $.command.run({ command: 'comms-as', args: 'all', ...PERSON })).text).toContain('not an id this session can take')
  })

  test('the public default: no agent channels, only #direct', async () => {
    expect(PUBLIC_DEFAULT.channels).toEqual([{ id: 'direct', members: ['reviewer', 'maintainer'] }])
    expect(PUBLIC_DEFAULT.reviewer_mode).toBe('code')
  })
})

describe('Windows (the plugin on a PC)', () => {
  const winMsg = (ch: string) => `${WIN_ROOT}/channels/${ch}/messages`
  const winAppr = (ch: string) => `${WIN_ROOT}/channels/${ch}/approvals`

  test('the default folder is %USERPROFILE%\\agent-comms; messages are written there with no program run', async ($, on) => {
    const w = world(on, { identity: '358', windows: true })
    await start($)
    const posted = await $.tool.call({ tool: 'mcp__agent-comms__comms_post', to: 'reviewer', kind: 'report', text: 'built on Windows' })
    expect(denial(posted)).toBeUndefined()
    const [path] = [...w.files.keys()].filter(p => p.startsWith(`${winMsg('358')}/`))
    expect(parse(w.files.get(path ?? '') ?? '', nameOf(path ?? '').slice(0, -5))).toMatchObject({ ok: true })
    expect(w.ran).toEqual([])
    expect([...w.files.keys()].some(p => p.endsWith('.tmp'))).toBe(false)
  })

  test('an approved reviewer message is delivered on Windows too', async ($, on) => {
    const w = world(on, { identity: '358', windows: true })
    const m = newMessage({ from: 'reviewer', to: '358', kind: 'ruling', body: 'ok on Windows', nowMs: T0 - 1000, hex: 'w1n001' })
    put(w, `${winMsg('358')}/${m.id}.json`, format(m))
    put(w, `${winAppr('358')}/${m.id}.json`, formatApproval({ id: m.id, by: 'maintainer', ts: '2026-10-03T12:00:02.000Z' }))
    await start($)
    await turn($, 1)
    expect(w.appended.some(t => t.includes('ok on Windows'))).toBe(true)
  })

  test('the guard knows Windows spellings: backslashes, any case, %USERPROFILE%, Git Bash /c/…', async ($, on) => {
    const w = world(on, { identity: '358', windows: true })
    await start($)
    const denied = [
      await $.tool.call({ tool: 'Write', file_path: 'C:\\Users\\me\\agent-comms\\channels\\358\\approvals\\x.json', content: '{}' }),
      await $.tool.call({ tool: 'Write', file_path: 'c:/users/ME/Agent-Comms/channels/358/approvals/y.json', content: '{}' }),
      await $.tool.call({ tool: 'Write', file_path: '..\\Users\\me\\agent-comms\\channels\\358\\messages\\z.json', content: '{}' }),
      await $.tool.call({ tool: 'Bash', command: 'del C:\\Users\\me\\agent-comms\\channels\\358\\messages\\a.json' }),
      await $.tool.call({ tool: 'Bash', command: 'Remove-Item $env:USERPROFILE\\agent-comms\\channels -Recurse' }),
      await $.tool.call({ tool: 'Bash', command: 'rm -rf /c/Users/me/agent-comms/channels' }),
      await $.tool.call({ tool: 'Bash', command: 'type nul > %USERPROFILE%\\agent-comms\\channels\\358\\approvals\\b.json' }),
    ]
    for (const r of denied) expect(denial(r)).toContain('comms_post')
    const allowed = [
      await $.tool.call({ tool: 'Write', file_path: 'C:\\work\\notes.txt', content: 'fine' }),
      await $.tool.call({ tool: 'Bash', command: 'dir C:\\work' }),
    ]
    for (const r of allowed) expect(denial(r)).toBeUndefined()
    expect(w.files.has(`${winAppr('358')}/x.json`)).toBe(false)
  })
})
