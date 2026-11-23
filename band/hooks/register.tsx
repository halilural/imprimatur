// Imprimatur's band above the Claude Code prompt, in every repo (loaded through CLAUDE_CODE_PLUGIN_DIRS).
// It answers "where am I, what next" in at most five rows, each shown only when it has something to say
// (spec BAND, 2026-11-23): the task in hand, what waits on the user, the repo and its CI, the sprint, and
// the context window once it is 70% full. What Claude Code's status line shows (model, cost) is not repeated.
// The last row is the repo's quick prompts (.claude/imprimatur.json "quickPrompts", else DEFAULTS).
import type { EngineInterface, Register } from 'claude-code'

export type QuickPrompt = { label: string; text: string }
export type Now = { key: string; step: string; next: boolean }
export type Waiting = { count: number; first?: { key: string; step: string } }
export type Git = { branch: string; dirty: number; ahead: number; upstream: boolean }
export type Ci = 'ok' | 'fail' | 'running'
export type Sprint = { title: string; closed: number; total: number; daysLeft?: number }
export type State = { now?: Now; waiting: Waiting; known?: boolean; git?: Git; ci?: Ci; sprint?: Sprint; context?: number }

export const DEFAULTS: QuickPrompt[] = [
  { label: 'Durum', text: 'şu an ne durumdayız?' },
  { label: 'Push', text: 'push et her şeyi' },
]

const valid = (p: any): p is QuickPrompt =>
  typeof p?.label === 'string' && p.label.trim() !== '' && typeof p?.text === 'string' && p.text.trim() !== ''

// A repo's file is not trusted text: control and bidi characters go (a label must not hide what it sends),
// and both are capped.
const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').trim().slice(0, n)

/** The repo's quick prompts from its .claude/imprimatur.json text, DEFAULTS when it has none. */
export function quickPromptsOf(config: string | undefined): QuickPrompt[] {
  try {
    const list = config === undefined ? undefined : JSON.parse(config).quickPrompts
    const mine = (Array.isArray(list) ? list.filter(valid) : [])
      .map(p => ({ label: clean(p.label, 24), text: clean(p.text, 300) }))
      .filter(p => p.label && p.text)
      .slice(0, 8)
    return mine.length ? mine : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

const tasksIn = (answer: any): any[] => (Array.isArray(answer?.tasks) ? answer.tasks : [])
const titled = (t: any) => typeof t?.title === 'string' && t.title.trim() !== ''

/** The task in hand from where_we_left_off: a 👉 that is not the user's, else an active task, else the next open one. */
export function nowOf(answer: any): Now | undefined {
  const tasks = tasksIn(answer)
  const p = tasks.find(t => typeof t?.pointer_title === 'string' && t.pointer_owner !== 'K')
  if (p) return { key: String(p.key), step: p.pointer_title, next: false }
  const a = tasks.find(t => t?.status === 'active' && titled(t))
  if (a) return { key: String(a.key), step: String(a.summary || a.title), next: false }
  const o = tasks.find(t => t?.status === 'open' && titled(t))
  return o ? { key: String(o.key), step: String(o.title), next: true } : undefined
}

/** Tasks whose 👉 is the user's (owner K): how many, and the first. */
export function waitingOf(answer: any): Waiting {
  const mine = tasksIn(answer).filter(t => t?.pointer_owner === 'K' && typeof t?.pointer_title === 'string')
  return { count: mine.length, first: mine[0] && { key: String(mine[0].key), step: mine[0].pointer_title } }
}

/** `git status --porcelain --branch`: "## main...origin/main [ahead 2]" then a line per changed file. */
export function gitOf(stdout: string): Git | undefined {
  const [head, ...files] = stdout.split('\n')
  const m = /^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head ?? '')
  if (!m) return undefined
  return {
    branch: m[1],
    dirty: files.filter(Boolean).length,
    ahead: Number(/ahead (\d+)/.exec(m[3] ?? '')?.[1] ?? 0),
    upstream: m[2] !== undefined,
  }
}

/** The newest run of `gh run list --json status,conclusion`: green, red or still going. */
export function ciOf(runs: any): Ci | undefined {
  const r = Array.isArray(runs) ? runs[0] : undefined
  if (!r) return undefined
  if (r.status !== 'completed') return 'running'
  return ['success', 'skipped', 'neutral'].includes(r.conclusion) ? 'ok' : 'fail'
}

/** The open "Sprint…" milestone due first: its closed and total issues, and whole days left (negative: past due). */
export function sprintOf(milestones: any, now: number): Sprint | undefined {
  const list: any[] = Array.isArray(milestones) ? milestones : []
  const m = list
    .filter(x => x?.state === 'open' && /^Sprint\b/.test(String(x?.title)))
    .sort((a, b) => String(a.due_on ?? '9').localeCompare(String(b.due_on ?? '9')))[0]
  if (!m) return undefined
  const closed = Number(m.closed_issues) || 0
  const due = m.due_on ? Date.parse(m.due_on) : NaN
  return {
    title: String(m.title).split(' · ')[0], // "Sprint 5 · Nov 4–10 · theme": the name alone fits a row
    closed,
    total: closed + (Number(m.open_issues) || 0),
    daysLeft: Number.isNaN(due) ? undefined : Math.ceil((due - now) / 86_400_000),
  }
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

let prompts: QuickPrompt[] = DEFAULTS
let state: State = { waiting: { count: 0 } }

/** An Imprimatur MCP tool's JSON answer, under the name the server has in this setup (user config, or the plugin's). */
async function imprimatur($: EngineInterface, tool: string): Promise<any> {
  for (const server of ['imprimatur', 'plugin:imprimatur:imprimatur']) {
    try {
      const r = await $.mcp.call(server, tool, {})
      const text = r.content.find((c: any) => c.type === 'text') as { text?: string } | undefined
      if (!r.isError && text?.text) return JSON.parse(text.text)
    } catch {
      // not this name: try the next
    }
  }
  return undefined
}

// A cloned repo's .git/config can name programs git runs (core.fsmonitor, hooks): turned off for these reads.
const GIT = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']

/** A command's stdout as JSON, undefined when it fails or is not JSON. */
async function json($: EngineInterface, argv: string[]): Promise<any> {
  try {
    const r = await $.process.run(argv)
    return r.exitCode === 0 ? JSON.parse(r.stdout) : undefined
  } catch {
    return undefined
  }
}

async function refresh($: EngineInterface) {
  prompts = quickPromptsOf(await $.fs.read('.claude/imprimatur.json').catch(() => undefined))
  const now = await $.clock.now().catch(() => Date.now())
  const status = await $.process.run([...GIT, 'status', '--porcelain', '--branch']).catch(() => undefined)
  const git = status?.exitCode === 0 ? gitOf(status.stdout) : undefined
  const [wwlo, milestones, runs, usage] = await Promise.all([
    imprimatur($, 'where_we_left_off'),
    git ? json($, ['gh', 'api', 'repos/{owner}/{repo}/milestones?state=open&per_page=50']) : undefined,
    git ? json($, ['gh', 'run', 'list', '--branch', git.branch, '--limit', '1', '--json', 'status,conclusion']) : undefined,
    $.session.usage().catch(() => undefined),
  ])
  // No answer (the MCP server still connecting) is not "no work": the last known rows stay, and none are made up.
  state = {
    now: wwlo ? nowOf(wwlo) : state.now,
    waiting: wwlo ? waitingOf(wwlo) : state.waiting,
    known: wwlo !== undefined || state.known,
    git,
    ci: ciOf(runs),
    sprint: sprintOf(milestones, now),
    context: usage?.context?.percent ?? undefined,
  }
  $.ui.invalidate('ui.render')
  return wwlo !== undefined
}

export const register: Register = on => {
  // At the start and after each turn: MCP, git and gh are not read while drawing.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // MCP servers join after the session starts: try again a few times until Imprimatur answers.
    void (async () => {
      for (let i = 0; i < 6 && !(await refresh($)); i++) await $.clock.sleep(5000)
    })()
    return r
  })
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    void refresh($)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const send = (text: string) => () => void $.prompt.submit({ text }).catch(() => $.ui.toast('Imprimatur: the prompt was not sent'))
    const { now, waiting, known, git: g, ci, sprint: s, context } = state
    // A fixed label column so every row's content starts at the same place; buttons only for short keys.
    const row = (id: string, label: string, ...body: any[]) => (
      <Box key={id} flexDirection="row" gap={1} alignItems="center">
        <Box width={13}><Text dimColor>{label}</Text></Box>
        {body}
      </Box>
    )

    const repoOff = !!g && (g.dirty > 0 || g.ahead > 0 || !g.upstream)
    const repo = g && [
      g.branch,
      g.dirty > 0 && `${g.dirty} değişiklik`,
      g.ahead > 0 && `${g.ahead} commit push'lanmadı`,
      !g.upstream && 'uzakta yok',
    ].filter(Boolean).join(' · ')
    const ciText = ci === 'ok' ? 'CI ✓' : ci === 'fail' ? 'CI ✗' : ci === 'running' ? 'CI …' : undefined
    const past = s?.daysLeft !== undefined && s.daysLeft < 0

    return (
      <Box flexDirection="column" width={e.surface === 'terminal' ? e.props.bodyColumns : undefined}>
        {now && row('now', now.next ? 'Sıradaki' : 'Şimdi',
          <Button key="now" plain label={now.key} onPress={send(`devam et: ${now.key}`)} />,
          <Text key="nowt">{short(now.step, 90)}</Text>)}
        {!now && known && row('now', 'Şimdi',
          <Text key="nowt" dimColor>açık iş yok</Text>,
          <Button key="now" plain label="sıradakini seç" onPress={send("açık issue'lara bak, sıradaki işi öner")} />)}
        {waiting.first && row('wait', `Seni bekliyor ${waiting.count}`,
          <Button key="wait" plain label={waiting.first.key} onPress={send(`${waiting.first.key}: bende bekleyen adımı göster ve birlikte yapalım`)} />,
          <Text key="waitt" color="warning">{short(waiting.first.step, 80)}</Text>)}
        {g && row('repo', 'Repo',
          <Text key="git" color={repoOff ? 'warning' : undefined} dimColor={!repoOff}>{repo}</Text>,
          ciText && <Text key="ci" color={ci === 'fail' ? 'error' : undefined} dimColor={ci !== 'fail'}>{ciText}</Text>)}
        {s && (past
          ? row('sprint', 'Sprint',
              <Text key="sprintt" color="warning">{`${short(s.title, 30)} bitti, ${-s.daysLeft!} gün önce`}</Text>,
              <Button key="sprint" plain label="planla" onPress={send('yeni sprint planla')} />)
          : row('sprint', 'Sprint',
              <Text key="sprintt" dimColor>{`${short(s.title, 30)} · ${s.closed}/${s.total} kapandı${s.daysLeft !== undefined ? ` · ${s.daysLeft} gün kaldı` : ''}`}</Text>))}
        {context !== undefined && context >= 70 && row('ctx', 'Bağlam',
          <Text key="ctx" color="warning">{`%${Math.round(context)} dolu · iyi bir yerde /compact`}</Text>)}
        {row('prompts', '', ...prompts.map((p, i) => <Button key={`p${i}`} plain label={p.label} onPress={send(p.text)} />))}
      </Box>
    )
  })

  // Ponytail's row, answered over with an empty Box (null is refused; this build has no AbovePromptList).
  on('ui.render', { component: 'AbovePrompt', plugin: 'ponytail' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}
