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
  // a workflow's script orchestrates agents; each agent's own tool calls are checked one by one
  'Workflow',
  // report-only: a subagent's result and a code review's findings write nothing
  'StructuredOutput',
  'ReportFindings',
  // shows or sends an existing file to the person: reads only
  'SendUserFile',
  'SendFile',
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

/**
 * Other input keys that name a path a tool may write: any key ending in path,
 * dir, directory, file, folder, dest, destination, target or output (out_dir,
 * output_path, saveFile…), so a tool with its own key names is checked too.
 */
export const PATH_KEY_PATTERN = /(path|paths|dir|directory|file|files|filename|file_name|folder|dest|destination|target|output|out|outfile|location|save_to|saveto)$/i

/** Keys naming a directory another key's relative path is joined to (out_dir + path). */
export const DIR_KEY_PATTERN = /(dir|directory|folder|cwd|root)$/i

/** Whether `key` holds a path to check: one of PATH_KEYS or a key matching PATH_KEY_PATTERN. */
export const isPathKey = (key: string): boolean => PATH_KEYS.has(key) || PATH_KEY_PATTERN.test(key)

/** Input keys holding a shell command. */
export const COMMAND_KEYS = new Set(['command', 'cmd', 'script'])

/** Skills / slash commands only the person runs. */
export const PERSON_ONLY_COMMAND = /(^|[\s/:])comms(-as|-setup|-approve|-group)?(\s|$)/

/** Strings under `keys` (a set, or a test on the key) anywhere in `input` (arrays and nested objects walked). */
export const stringsUnder = (input: unknown, keys: ReadonlySet<string> | ((key: string) => boolean), depth = 0): string[] => {
  if (depth > 6 || typeof input !== 'object' || input === null) return []
  const found: string[] = []
  const wanted = typeof keys === 'function' ? keys : (key: string) => keys.has(key)
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (wanted(key)) {
      if (typeof value === 'string') found.push(value)
      if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') found.push(v)
    }
    if (typeof value === 'object' && value !== null) found.push(...stringsUnder(value, keys, depth + 1))
  }

  return found
}

/** Windows backslashes as forward slashes: every path here is compared in that one spelling. */
export const toSlashes = (path: string): string => path.replace(/\\/g, '/')

/** `/x` (macOS, Linux), `C:/x` (Windows, after toSlashes) or `//server/share` (a Windows network path). */
const isAbsolutePath = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\//.test(path)

/**
 * `~`, `$HOME`, `%USERPROFILE%` and `$env:USERPROFILE` expanded, made absolute
 * under `cwd`, `.` and `..` folded; a Windows path keeps its drive (`C:/…`).
 */
export const absolutize = (path: string, cwd: string, home: string, onWindows = /^[A-Za-z]:\//.test(toSlashes(home))): string => {
  const h = toSlashes(home)
  // a file:// address names the same path
  let p = path.trim().replace(/^file:\/\/(localhost)?(?=\/)/i, '')
  // file:///C:/x names C:/x (a URL keeps a slash before the drive)
  if (/^file:/i.test(path.trim()) && /^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1)
  try {
    if (/%[0-9A-Fa-f]{2}/.test(p) && path.trim().toLowerCase().startsWith('file:')) p = decodeURIComponent(p)
  } catch {
    // a malformed escape: keep it as written
  }
  // backslashes are separators only on Windows; elsewhere they are ordinary characters in a name
  if (onWindows) p = toSlashes(p)
  if (onWindows) {
    // Windows' long-path forms: \\?\C:\x and \\?\UNC\server\share are C:/x and //server/share;
    // the loopback admin share \\localhost\C$\x is C:/x
    p = p.replace(/^\/\/[?.]\/UNC\//i, '//').replace(/^\/\/[?.]\/(?=[A-Za-z]:)/, '')
    p = p.replace(/^\/\/(localhost|127\.0\.0\.1|\.)\/([A-Za-z])\$(?=\/|$)/i, '$2:')
  }
  if (p === '~' || p.startsWith('~/')) p = h + p.slice(1)
  p = p.replace(/^(\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE)(?=\/|$)/i, h)
  // Windows only: a drive-relative path (C:x) is relative to that drive's current folder (the session's, on the same drive)
  const driveRelative = onWindows ? /^([A-Za-z]:)(?!\/)(.*)$/.exec(p) : null
  if (driveRelative) {
    const c = toSlashes(cwd)
    const sameDrive = c.slice(0, 2).toUpperCase() === (driveRelative[1] ?? '').toUpperCase()
    p = `${sameDrive ? c.replace(/\/+$/, '') : `${driveRelative[1]}`}/${driveRelative[2] ?? ''}`
  }
  const absolute = onWindows ? isAbsolutePath(p) : p.startsWith('/')
  if (!absolute) p = `${toSlashes(cwd).replace(/\/+$/, '')}/${p}`
  // a network path keeps its two leading slashes (Windows)
  let drive = onWindows && /^\/\/[^/]/.test(p) ? '/' : ''
  const withDrive = onWindows ? /^([A-Za-z]:)(\/.*)?$/.exec(p) : null
  if (withDrive) {
    drive = (withDrive[1] ?? '').toUpperCase()
    p = withDrive[2] ?? '/'
  }
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }

  return `${drive}/${out.join('/')}`
}

/**
 * Whether `path` is `root` or under it. Compared without case (macOS and
 * Windows file systems ignore it by default, and a guard errs on the side of
 * denying), and with macOS's `/System/Volumes/Data` spelling of the same path folded.
 */
/**
 * A Windows path as Windows reads it: a name's trailing dots and spaces are dropped and a ":stream"
 * suffix names the same file, so "agent-comms." and "agent-comms::$INDEX_ALLOCATION" are the folder.
 */
export const foldWindowsNames = (path: string): string =>
  path
    .split('/')
    .map((c, i) => (i === 0 && /^[A-Za-z]:$/.test(c)) || /^\.{1,2}$/.test(c) ? c : c.replace(/:.*$/, '').replace(/[. ]+$/, ''))
    .join('/')

export const isInside = (path: string, root: string): boolean => {
  const fold = (s: string) => toSlashes(s).normalize('NFC').replace(/^\/System\/Volumes\/Data(?=\/)/i, '').toLowerCase()
  const p = fold(path)
  const r = fold(root)
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`)
}

/**
 * Programs that only read whatever their arguments: a shell command made only
 * of these, with no redirection, never writes. (Programs that can write a file
 * through an argument, such as uniq IN OUT, tree -o, xxd IN OUT or plutil, are
 * left out; sort, rg and git are checked option by option below.)
 */
const READ_ONLY_PROGRAMS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'ls', 'grep', 'egrep', 'fgrep', 'wc', 'stat', 'file', 'jq',
  'diff', 'cmp', 'du', 'readlink', 'realpath', 'basename', 'dirname', 'cut', 'nl',
  'echo', 'printf', 'test', '[', 'true', 'pwd', 'shasum', 'md5', 'md5sum', 'sha256sum', 'od', 'hexdump',
])
/** git subcommands that only read (their options are checked too). */
const READ_ONLY_GIT = new Set(['log', 'show', 'status', 'diff', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch', 'remote'])
/** Environment variables a read may set in front of it: none of them makes a program run another. */
const HARMLESS_ENV = /^(LC_[A-Z_]+|LANG|LANGUAGE|NO_COLOR|TERM|COLUMNS|LINES|TZ)=/
/** find (and bfs, Claude Code's find) actions that write, delete or run a program, as whole words. */
const FIND_WRITES = /^-(delete|rm|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/

/**
 * Whether a shell command only reads: every part (split on ; & && || | |& and
 * newlines) runs a read-only program with options that write nothing or run
 * nothing else, and the command holds no output redirection, no tee, no
 * parenthesis (command or process substitution, a subshell, PowerShell's
 * (...) and @(...)) and no backquote. Best effort, like the rest of the shell check.
 */
/**
 * The command with quoted text blanked to spaces (same length): single-quoted text is literal in bash, zsh
 * and PowerShell; double-quoted text too, except `$(`…`)` and backquotes, which are kept so they still count.
 */
const blankQuoted = (command: string): { text: string; open: boolean } => {
  let out = ''
  let quote: '' | "'" | '"' | '$' = ''
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? ''
    const next = command[i + 1] ?? ''
    if (quote === '') {
      if (ch === '\\') {
        // an escaped character is literal (a line continuation is nothing at all)
        out += next === '\n' ? '  ' : `\\${next === '' ? '' : ' '}`
        i += 1
      } else if (ch === '#' && (i === 0 || /[\s;&|()<>]/.test(command[i - 1] ?? ''))) {
        // a comment (a # that starts a word) runs to the end of the line
        while (i < command.length && command[i] !== '\n') {
          out += ' '
          i += 1
        }
        if (i < command.length) out += '\n'
      } else if (ch === '$' && next === "'") {
        quote = '$'
        out += "$'"
        i += 1
      } else {
        if (ch === "'" || ch === '"') quote = ch
        out += ch
      }
    } else if (quote === '$') {
      // $'…': backslash escapes, ended by an unescaped '
      if (ch === '\\') {
        out += '  '
        i += 1
      } else if (ch === "'") {
        quote = ''
        out += ch
      } else out += ' '
    } else if (ch === quote) {
      quote = ''
      out += ch
    } else if (quote === '"' && ch === '\\') {
      out += '  '
      i += 1
    } else if (quote === '"' && (ch === '`' || (ch === '$' && next === '(') || (ch === '(' && command[i - 1] === '$'))) {
      out += ch
    } else {
      out += ' '
    }
  }

  return { text: out, open: quote !== '' }
}

/** git options before the subcommand that change nothing about what runs. */
const HARMLESS_GIT_GLOBALS = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects'])

export const isReadOnlyCommand = (command: string): boolean => {
  const lexed = blankQuoted(command)
  // a quote left open: the shell would not run this as written, and nothing after it can be judged
  if (lexed.open) return false
  const bare = lexed.text
  if (/[`()]|>(?!\s*&?\s*(1|2|\/dev\/null)\b)|\btee\b/.test(bare)) return false
  // split where the shell would, found on the quote-blanked text (a ; inside quotes is not a separator)
  const parts: string[] = []
  let from = 0
  for (const sep of bare.matchAll(/;|&&|\|\||\|&?|(?<![<>])&(?!>)|\r|\n/g)) {
    parts.push(command.slice(from, sep.index))
    from = (sep.index ?? 0) + sep[0].length
  }
  parts.push(command.slice(from))
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    parts[i] = (parts[i] ?? '').trim()
    if (parts[i] === '') parts.splice(i, 1)
  }
  if (parts.length === 0) return false
  return parts.every(part => {
    const raw = part.split(/\s+/)
    let at = 0
    while (at < raw.length && /^\w+=/.test(raw[at] ?? '')) {
      if (!HARMLESS_ENV.test(raw[at] ?? '')) return false
      at += 1
    }
    // quotes and backslashes are what the shell takes away before the program sees a word
    const words = raw.slice(at).map(w => w.replace(/['"\\]/g, ''))
    const program = (words[0] ?? '').replace(/^.*\//, '')
    const args = words.slice(1)
    if (program === 'git') {
      // global options before the subcommand (-c, --exec-path, --git-dir…) can change what runs; a few cannot
      let first = 0
      while (first < args.length && HARMLESS_GIT_GLOBALS.has(args[first] ?? '')) first += 1
      const sub = args[first] ?? ''
      if (!READ_ONLY_GIT.has(sub)) return false
      return !args.some(w => /^--(output|ext-diff|open-files-in-pager|textconv)(=|$)|^-O/.test(w))
    }
    if (program === 'find') return !args.some(w => FIND_WRITES.test(w))
    if (program === 'sort') return !args.some(w => /^-[^-]*o/.test(w) || /^--output(=|$)/.test(w))
    if (program === 'rg') return !args.some(w => /^--pre(-glob)?(=|$)/.test(w))
    return READ_ONLY_PROGRAMS.has(program)
  })
}

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
    // Windows: %USERPROFILE% and PowerShell's $env:USERPROFILE, and Git Bash's /c/Users/… for C:/Users/…
    if (root.toLowerCase().startsWith(`${home.toLowerCase()}/`) && /^[A-Za-z]:\//.test(home)) {
      const rest = root.slice(home.length)
      out.add(`%USERPROFILE%${rest}`)
      out.add(`$env:USERPROFILE${rest}`)
    }
    const drive = /^([A-Za-z]):(\/.*)$/.exec(root)
    if (drive) out.add(`/${(drive[1] ?? '').toLowerCase()}${drive[2] ?? ''}`)
  }
  // each spelling with Windows backslashes too (`C:\\Users\\me\\agent-comms`)
  for (const spelling of [...out]) if (spelling.includes('/')) out.add(spelling.replace(/\//g, '\\'))

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
  // macOS and Windows file systems ignore case (as isInside does): compare without case everywhere
  const lower = command.toLowerCase()
  if (spellings.some(s => lower.includes(s.toLowerCase()))) return true
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return new RegExp(`(^|[\\s;&|(<>'"=])(\\.[/\\\\])?${escaped}[/\\\\]`, 'i').test(command)
}

export const denyText = (root: string): string =>
  `agent-comms: ${root} is written only through the comms tools. Use comms_post to send a message and comms_read to read yours; do not create, change, move or delete files there (approvals are the maintainer's, from the /comms pane).`
