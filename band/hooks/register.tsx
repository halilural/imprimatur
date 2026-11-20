// Imprimatur's band above the Claude Code prompt, in every repo (loaded through CLAUDE_CODE_PLUGIN_DIRS):
// the task worked on last and its 👉 step, how many tasks wait on the user, the repo's git state, and quick
// prompts that send at a click. The prompts come from the repo's .claude/imprimatur.json "quickPrompts";
// a repo without one gets DEFAULTS. Ponytail's own row is hidden: its commands are prompts like any other.
// Above it, always open (user, 20.11.2026), "Neredeyiz": what waits on the user, open work, today's done tasks
// and the sprint, each row a button that sends its prompt; refreshed with the rest after each turn.
import type { EngineInterface, Register } from 'claude-code'

export type QuickPrompt = { label: string; text: string }
export type Info = { task?: { key: string; step: string }; waiting: number; git?: { dirty: number; ahead: number } }

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

/** From where_we_left_off: the first task with a 👉, and how many tasks' 👉 is the user's (owner K). */
export function tasksOf(answer: any): Pick<Info, 'task' | 'waiting'> {
  const tasks: any[] = Array.isArray(answer?.tasks) ? answer.tasks : []
  const t = tasks.find(x => typeof x?.pointer_title === 'string')
  return {
    task: t ? { key: String(t.key), step: t.pointer_title } : undefined,
    waiting: tasks.filter(x => x?.pointer_owner === 'K').length,
  }
}

const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export type Row = { key: string; text: string }
export type Sprint = { title: string; closed: number; total: number }
/** The "Neredeyiz" section: open work, what waits on the user, what finished today, the sprint. */
export type Where = { open: Row[]; waiting: Row[]; done: Row[]; sprint?: Sprint }

/** Open work and the user's from where_we_left_off: each task with a 👉, the user's (owner K) apart. */
export function whereOf(answer: any): Pick<Where, 'open' | 'waiting'> {
  const tasks: any[] = (Array.isArray(answer?.tasks) ? answer.tasks : []).filter((t: any) => typeof t?.pointer_title === 'string')
  const row = (t: any): Row => ({ key: String(t.key), text: t.pointer_title })
  return {
    open: tasks.filter(t => t.pointer_owner !== 'K').slice(0, 6).map(row),
    waiting: tasks.filter(t => t.pointer_owner === 'K').slice(0, 6).map(row),
  }
}

/** Tasks done since `since` (ms), newest first, from task_list status done. */
export function doneOf(answer: any, since: number): Row[] {
  const tasks: any[] = Array.isArray(answer?.tasks) ? answer.tasks : []
  return tasks.filter(t => Number(t?.done_at) >= since).slice(0, 5).map(t => ({ key: String(t.key), text: String(t.title ?? '') }))
}

/** The open sprint milestone due first (GitHub milestones JSON): its closed and total issue counts. */
export function sprintOf(milestones: any): Sprint | undefined {
  const list: any[] = Array.isArray(milestones) ? milestones : []
  const m = list
    .filter(x => x?.state === 'open' && /^Sprint\b/.test(String(x?.title)))
    .sort((a, b) => String(a.due_on ?? '9').localeCompare(String(b.due_on ?? '9')))[0]
  return m ? { title: String(m.title), closed: Number(m.closed_issues) || 0, total: (Number(m.closed_issues) || 0) + (Number(m.open_issues) || 0) } : undefined
}

let prompts: QuickPrompt[] = DEFAULTS
let info: Info = { waiting: 0 }
let where: Where = { open: [], waiting: [], done: [] }

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

/** The section's slower parts: every done task (filtered to today) and GitHub's milestones. */
async function details($: EngineInterface): Promise<Pick<Where, 'done' | 'sprint'>> {
  const midnight = new Date(await $.clock.now().catch(() => Date.now()))
  midnight.setHours(0, 0, 0, 0)
  const done = doneOf(await imprimatur($, 'task_list', { status: 'done' }), midnight.getTime())
  const gh = await $.process.run(['gh', 'api', 'repos/{owner}/{repo}/milestones?state=open&per_page=50']).catch(() => undefined)
  let sprint: Sprint | undefined
  try {
    sprint = gh?.exitCode === 0 ? sprintOf(JSON.parse(gh.stdout)) : undefined
  } catch {
    sprint = undefined
  }
  return { done, sprint }
}

// A cloned repo's .git/config can name programs git runs (core.fsmonitor, hooks): turned off for these reads.
const GIT = ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']

async function gitState($: EngineInterface): Promise<Info['git']> {
  const status = await $.process.run([...GIT, 'status', '--porcelain']).catch(() => undefined)
  if (!status || status.exitCode !== 0) return undefined // not a git repo
  const ahead = await $.process.run([...GIT, 'rev-list', '--count', '@{u}..HEAD']).catch(() => undefined)
  return {
    dirty: status.stdout.split('\n').filter(Boolean).length,
    ahead: ahead?.exitCode === 0 ? Number(ahead.stdout.trim()) || 0 : 0,
  }
}

async function refresh($: EngineInterface) {
  prompts = quickPromptsOf(await $.fs.read('.claude/imprimatur.json').catch(() => undefined))
  const wwlo = await imprimatur($, 'where_we_left_off')
  info = { ...tasksOf(wwlo), git: await gitState($) }
  where = { ...whereOf(wwlo), ...(await details($)) }
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  // At the start and after each turn: MCP, git and the file are not read while drawing.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    void refresh($)
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
    const g = info.git
    // One section of "Neredeyiz": a dim heading and a button per row; nothing when it has no rows.
    const section = (id: string, title: string, rows: Row[], ask: (r: Row) => string) =>
      rows.length > 0 && (
        <Box key={id} flexDirection="column">
          <Text dimColor>{title}</Text>
          {/* Buttons have no tooltip (hover only restyles) and take a plain label: the key is the button,
              the text beside it, wrapping (maxLines is refused above the prompt), capped at 160. */}
          {rows.map((r, i) => (
            <Box key={`${id}r${i}`} flexDirection="row" gap={1}>
              <Button key={`${id}${i}`} plain label={r.key} onPress={send(ask(r))} />
              <Text>{short(r.text, 160)}</Text>
            </Box>
          ))}
        </Box>
      )
    const s = where.sprint
    return (
      <Box flexDirection="column" width={e.surface === 'terminal' ? e.props.bodyColumns : undefined}>
        <Box flexDirection="column" gap={1}>
          <Text bold>Neredeyiz</Text>
            {section('w', 'Senden beklenen', where.waiting, r => `${r.key}: bende bekleyen adımı göster ve birlikte yapalım`)}
            {section('o', 'Açık işler', where.open, r => `devam et: ${r.key}`)}
            {section('d', 'Bugün biten', where.done, r => `${r.key} ne getirdi, kısaca özetle`)}
            {s && <Button key="sprint" plain label={`${s.title} · ${s.closed} / ${s.total} kapandı`} onPress={send('sprint durumunu göster')} />}
        </Box>
        <Box flexDirection="row" alignItems="center" gap={2}>
          {info.task && <Button key="task" plain label={`👉 ${info.task.key} · ${short(info.task.step)}`} onPress={send(`devam et: ${info.task.key}`)} />}
          {info.waiting > 0 && <Text color="warning">Seni bekliyor: {info.waiting}</Text>}
          {g && (g.dirty || g.ahead
            ? <Text color="warning">{[g.dirty && `${g.dirty} değişiklik`, g.ahead && `${g.ahead} commit push'lanmadı`].filter(Boolean).join(' · ')}</Text>
            : <Text dimColor>✓ push'lu</Text>)}
        </Box>
        <Box flexDirection="row" alignItems="center" gap={2}>
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
