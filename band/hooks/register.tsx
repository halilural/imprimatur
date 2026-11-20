// Imprimatur's band above the Claude Code prompt, in every repo (loaded through CLAUDE_CODE_PLUGIN_DIRS):
// the task worked on last and its 👉 step, how many tasks wait on the user, the repo's git state, and quick
// prompts that send at a click. The prompts come from the repo's .claude/imprimatur.json "quickPrompts";
// a repo without one gets DEFAULTS. Ponytail's own row is hidden: its commands are prompts like any other.
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

let prompts: QuickPrompt[] = DEFAULTS
let info: Info = { waiting: 0 }

/** where_we_left_off, under the name the MCP server has in this setup (user config, or the plugin's). */
async function whereWeLeftOff($: EngineInterface): Promise<any> {
  for (const server of ['imprimatur', 'plugin:imprimatur:imprimatur']) {
    try {
      const r = await $.mcp.call(server, 'where_we_left_off', {})
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
  info = { ...tasksOf(await whereWeLeftOff($)), git: await gitState($) }
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
    return (
      <Box flexDirection="column" width={e.surface === 'terminal' ? e.props.bodyColumns : undefined}>
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
