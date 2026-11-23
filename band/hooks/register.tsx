// Imprimatur's band above the Claude Code prompt, in every repo (loaded through CLAUDE_CODE_PLUGIN_DIRS).
// It answers three questions, each row one click from acting on it (user, 2026-11-23): what finished
// (Bitti), what is in progress (Açık), and what to start next (Sıradaki). Around them, only rows that ask
// the user for something: what waits on them, a sprint that ended, a context window past 70%. Then the
// repo's quick prompts (.claude/imprimatur.json "quickPrompts", else DEFAULTS).
import type { EngineInterface, Register } from 'claude-code'

export type QuickPrompt = { label: string; text: string }
export type Row = { key: string; text: string }
export type Sprint = { title: string; closed: number; total: number; daysLeft?: number }
export type State = {
  known: boolean // Imprimatur has answered at least once
  done: Row[]
  open: Row[]
  next?: Row
  waiting: Row[]
  sprint?: Sprint
  context?: number
}

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
// AUTOPILOT runs by itself (the setup autopilot), and a task with no title says nothing on a row.
const shown = (t: any) => t?.key !== 'AUTOPILOT' && typeof t?.title === 'string' && t.title.trim() !== ''
const pointed = (t: any) => typeof t?.pointer_title === 'string'

/**
 * From where_we_left_off: in progress (active, or a 👉 that is the agent's), the first open task not started
 * as the next, and the tasks whose 👉 is the user's.
 */
export function workOf(answer: any): Pick<State, 'open' | 'next' | 'waiting'> {
  const tasks = tasksIn(answer).filter(shown)
  const mine = tasks.filter(t => pointed(t) && t.pointer_owner === 'K')
  const going = tasks.filter(t => !mine.includes(t) && (t.status === 'active' || pointed(t)))
  const next = tasks.find(t => t.status === 'open' && !pointed(t))
  return {
    open: going.slice(0, 3).map(t => ({ key: String(t.key), text: String(t.pointer_title ?? (t.summary || t.title)) })),
    next: next && { key: String(next.key), text: String(next.title) },
    waiting: mine.slice(0, 2).map(t => ({ key: String(t.key), text: String(t.pointer_title) })),
  }
}

/** The latest done tasks from task_list {status: done, limit}. */
export function doneOf(answer: any): Row[] {
  return tasksIn(answer).filter(shown).slice(0, 2).map(t => ({ key: String(t.key), text: String(t.title) }))
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
let state: State = { known: false, done: [], open: [], waiting: [] }

/** An Imprimatur MCP tool's JSON answer, under the name the server has in this setup (user config, or the plugin's). */
async function imprimatur($: EngineInterface, tool: string, args: Record<string, unknown> = {}): Promise<any> {
  for (const server of ['imprimatur', 'plugin:imprimatur:imprimatur']) {
    try {
      const r = await $.mcp.call(server, tool, args)
      const text = r.content.find((c: any) => c.type === 'text') as { text?: string } | undefined
      if (!r.isError && text?.text) return JSON.parse(text.text)
    } catch {
      // not this name: try the next
    }
  }
  return undefined
}

/** GitHub's open milestones through gh, undefined outside a GitHub repo. */
async function ghMilestones($: EngineInterface): Promise<any> {
  try {
    const r = await $.process.run(['gh', 'api', 'repos/{owner}/{repo}/milestones?state=open&per_page=50'])
    return r.exitCode === 0 ? JSON.parse(r.stdout) : undefined
  } catch {
    return undefined
  }
}

/** Reads everything the band shows; false while Imprimatur has not answered (its server joins after the start). */
async function refresh($: EngineInterface): Promise<boolean> {
  prompts = quickPromptsOf(await $.fs.read('.claude/imprimatur.json').catch(() => undefined))
  const now = await $.clock.now().catch(() => Date.now())
  const [wwlo, done, ms, usage] = await Promise.all([
    imprimatur($, 'where_we_left_off'),
    imprimatur($, 'task_list', { status: 'done', limit: 4 }),
    ghMilestones($),
    $.session.usage().catch(() => undefined),
  ])
  // No answer is not "no work": the last known rows stay, and none are made up.
  state = {
    ...state,
    ...(wwlo && { known: true, ...workOf(wwlo) }),
    ...(done && { done: doneOf(done) }),
    sprint: sprintOf(ms, now),
    context: usage?.context?.percent ?? undefined,
  }
  $.ui.invalidate('ui.render')
  return wwlo !== undefined
}

export const register: Register = on => {
  // At the start and after each turn: MCP and gh are not read while drawing.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
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
    const { known, done, open, next: nx, waiting, sprint: s, context } = state
    // Three columns (user, 2026-11-23: small buttons, the description apart, space and a line between):
    // the section label, a fixed-width column for the short button, then the text cut at the edge.
    // nowrap: VS Code otherwise drops a long text under its button.
    const row = (id: string, label: string, button: any, text?: any) => (
      <Box key={id} flexDirection="row" flexWrap="nowrap" gap={1} alignItems="center" paddingY={e.surface === 'terminal' ? 0 : 0.25}>
        <Box width={9} flexShrink={0}><Text dimColor>{label}</Text></Box>
        <Box width={9} flexShrink={0}>{button}</Box>
        {text && <Box flexGrow={1} flexShrink={1} minWidth={0}>{text}</Box>}
      </Box>
    )
    const line = (id: string, label: string, r: Row, ask: string) => row(id, label,
      <Button key={id} plain label={r.key} onPress={send(ask)} />,
      <Text wrap="truncate-end">{r.text}</Text>)
    // A section: its rows with a little space between, a dim rule under it.
    const rule = (id: string) => <Text key={id} dimColor wrap="truncate">{'─'.repeat(e.props.bodyColumns || 80)}</Text>
    const section = (id: string, rows: any[]) => rows.length > 0 && (
      <Box key={id} flexDirection="column">{rows}{rule(`${id}-rule`)}</Box>
    )
    const past = s?.daysLeft !== undefined && s.daysLeft < 0

    return (
      <Box flexDirection="column" width={e.surface === 'terminal' ? e.props.bodyColumns : undefined}>
        {section('done', done.map((r, i) => line(`d${i}`, i ? '' : 'Bitti', r, `${r.key} ne getirdi, kısaca özetle`)))}
        {section('open', open.map((r, i) => line(`o${i}`, i ? '' : 'Açık', r, `devam et: ${r.key}`)))}
        {section('next', nx ? [line('next', 'Sıradaki', nx, `başla: ${nx.key}`)] : known ? [row('next', 'Sıradaki',
          <Button key="next" plain label="seç" onPress={send("açık issue'lara bak, sıradaki işi öner ve başla")} />,
          <Text dimColor>açık iş yok</Text>)] : [])}
        {section('wait', waiting.map((r, i) => line(`w${i}`, i ? '' : 'Sende', r, `${r.key}: bende bekleyen adımı göster ve birlikte yapalım`)))}
        {section('sprint', [
          s && past && row('sprint', 'Sprint',
            <Button key="sprint" plain label="planla" onPress={send('yeni sprint planla')} />,
            <Text color="warning" wrap="truncate-end">{`${s.title} bitti, ${-s.daysLeft!} gün önce`}</Text>),
          s && !past && row('sprint', 'Sprint', undefined,
            <Text dimColor wrap="truncate-end">{`${s.title} · ${s.closed}/${s.total} kapandı${s.daysLeft !== undefined ? ` · ${s.daysLeft} gün kaldı` : ''}`}</Text>),
          context !== undefined && context >= 70 && row('ctx', 'Bağlam', undefined,
            <Text color="warning">{`%${Math.round(context)} dolu · iyi bir yerde /compact`}</Text>),
        ].filter(Boolean))}
        <Box flexDirection="row" gap={1}>
          {prompts.map((p, i) => <Button key={`p${i}`} plain label={p.label} onPress={send(p.text)} />)}
        </Box>
      </Box>
    )
  })

  // Ponytail's row, answered over with an empty Box (null is refused; this build has no AbovePromptList).
  on('ui.render', { component: 'AbovePrompt', plugin: 'ponytail' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}
