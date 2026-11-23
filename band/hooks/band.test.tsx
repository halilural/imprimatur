import { expect, test } from 'claude-code/testing'
import { ciOf, DEFAULTS, gitOf, nowOf, quickPromptsOf, sprintOf, waitingOf } from './register.tsx'

const BAND = {
  plugin: 'imprimatur-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 100 },
} as const

const WWLO = {
  tasks: [
    { key: '#206', status: 'open', title: 'Band', pointer_title: 'Add the band', pointer_owner: 'C' },
    { key: '#176', status: 'open', title: 'PDFs', pointer_title: 'Send the PDFs', pointer_owner: 'K' },
    { key: 'AUTOPILOT', status: 'active', title: 'Setup autopilot', summary: 'Last run: 3 fixed', pointer_title: null },
  ],
}
const DAY = 86_400_000

test('the repo list wins; none, empty or broken falls back to the defaults', async () => {
  expect(quickPromptsOf(JSON.stringify({ quickPrompts: [{ label: 'Push', text: 'push' }, { label: '', text: 'x' }] }))).toEqual([{ label: 'Push', text: 'push' }])
  for (const c of [undefined, '{}', '{"quickPrompts":[]}', 'not json']) expect(quickPromptsOf(c)).toEqual(DEFAULTS)
})

test('a repo\'s prompts lose control and bidi characters and are capped', async () => {
  const [p] = quickPromptsOf(JSON.stringify({ quickPrompts: [{ label: 'Du‮rum\u0007', text: `a​b${'x'.repeat(400)}` }] }))
  expect(p.label).toBe('Du rum')
  expect(p.text.startsWith('a b')).toBe(true)
  expect(p.text.length).toBe(300)
})

test('the task in hand: the agent\'s 👉, else an active task, else the next open one; untitled skipped', async () => {
  expect(nowOf(WWLO)).toEqual({ key: '#206', step: 'Add the band', next: false })
  const noPointer = { tasks: [{ key: 'X', status: 'active', title: '' }, ...WWLO.tasks.slice(2)] }
  expect(nowOf(noPointer)).toEqual({ key: 'AUTOPILOT', step: 'Last run: 3 fixed', next: false })
  expect(nowOf({ tasks: [{ key: 'U', status: 'open', title: '' }, { key: '#236', status: 'open', title: 'Report' }] }))
    .toEqual({ key: '#236', step: 'Report', next: true })
  expect(nowOf(undefined)).toBe(undefined)
})

test('what waits on the user: the count and the first', async () => {
  expect(waitingOf(WWLO)).toEqual({ count: 1, first: { key: '#176', step: 'Send the PDFs' } })
  expect(waitingOf({})).toEqual({ count: 0, first: undefined })
})

test('git: branch, upstream, ahead and changed files from one porcelain call', async () => {
  expect(gitOf('## main...origin/main [ahead 2, behind 1]\n M a.ts\n?? b.ts\n')).toEqual({ branch: 'main', dirty: 2, ahead: 2, upstream: true })
  expect(gitOf('## feat/band-where\n')).toEqual({ branch: 'feat/band-where', dirty: 0, ahead: 0, upstream: false })
  expect(gitOf('## main...origin/main\n')).toEqual({ branch: 'main', dirty: 0, ahead: 0, upstream: true })
  expect(gitOf('')).toBe(undefined)
})

test('CI: the newest run green, red or running', async () => {
  expect(ciOf([{ status: 'completed', conclusion: 'success' }])).toBe('ok')
  expect(ciOf([{ status: 'completed', conclusion: 'failure' }])).toBe('fail')
  expect(ciOf([{ status: 'in_progress', conclusion: '' }])).toBe('running')
  expect(ciOf([])).toBe(undefined)
})

test('the sprint due first, with days left; a past one counts days since', async () => {
  const now = Date.parse('2026-11-23T12:00:00Z')
  const ms = [
    { title: 'Sprint 10', state: 'open', due_on: '2026-12-04T00:00:00Z', open_issues: 2, closed_issues: 0 },
    { title: 'Sprint 9', state: 'open', due_on: '2026-11-27T00:00:00Z', open_issues: 11, closed_issues: 1 },
    { title: 'Backlog', state: 'open', due_on: null, open_issues: 5, closed_issues: 0 },
  ]
  expect(sprintOf(ms, now)).toEqual({ title: 'Sprint 9', closed: 1, total: 12, daysLeft: 4 })
  expect(sprintOf([{ title: 'Sprint 5', state: 'open', due_on: '2026-11-09T00:00:00Z', open_issues: 0, closed_issues: 31 }], now)?.daysLeft).toBe(-14)
  expect(sprintOf('nope', now)).toBe(undefined)
})

function fake(on: any, o: { wwlo: any; status: string; ms?: any; runs?: any; percent?: number; sent: string[]; argvs?: string[][] }) {
  on('fs.read', () => ({ value: '{}' }))
  on('clock.now', () => ({ value: Date.parse('2026-11-23T12:00:00Z') }))
  on('mcp.call', () => ({ value: o.wwlo === undefined ? { content: [], isError: true } : { content: [{ type: 'text', text: JSON.stringify(o.wwlo) }], isError: false } }))
  on('process.run', (_: any, e: any) => {
    o.argvs?.push(e.argv)
    const out = e.argv[0] === 'git' ? o.status : e.argv[1] === 'run' ? JSON.stringify(o.runs ?? []) : JSON.stringify(o.ms ?? [])
    return { value: { exitCode: 0, stdout: out, stderr: '' } }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { percent: o.percent ?? 10 } } }))
  on('prompt.submit', (_: any, e: any) => (o.sent.push(e.text), { text: e.text }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({}))
}

test('the band: task, waiting, repo with CI, a past sprint to plan, context; presses send', async ($, on) => {
  const sent: string[] = []
  const argvs: string[][] = []
  fake(on, {
    wwlo: WWLO, sent, argvs, percent: 82,
    status: '## main...origin/main [ahead 2]\n M a.ts\n',
    runs: [{ status: 'completed', conclusion: 'failure' }],
    ms: [{ title: 'Sprint 5', state: 'open', due_on: '2026-11-09T00:00:00Z', open_issues: 0, closed_issues: 31 }],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 0))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /^main · 1 değişiklik · 2 commit push'lanmadı$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^CI ✗$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /%82 dolu/ })).toBeTruthy()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'now' })
  await ui.press({ key: 'wait' })
  await ui.press({ key: 'sprint' })
  await ui.press({ key: 'p0' })
  expect(sent).toEqual(['devam et: #206', '#176: bende bekleyen adımı göster ve birlikte yapalım', 'yeni sprint planla', DEFAULTS[0].text])
  await ui.unmount()
  // git runs no program a cloned repo's config names
  const gits = argvs.filter(a => a[0] === 'git')
  expect(gits.length > 0 && gits.every(a => a.includes('core.fsmonitor=false') && a.includes('core.hooksPath=/dev/null'))).toBe(true)
})

test('Imprimatur not answering yet is not "no work": no task row is made up', async ($, on) => {
  const sent: string[] = []
  fake(on, { wwlo: undefined, sent, status: '## main...origin/main\n' })
  on('clock.sleep', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 0))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /açık iş yok/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeTruthy()
  await ui.unmount()
})

test('nothing open, clean repo, context low: empty rows hidden, the "pick next" button shows', async ($, on) => {
  const sent: string[] = []
  fake(on, { wwlo: { tasks: [] }, sent, status: '## main...origin/main\n', runs: [{ status: 'completed', conclusion: 'success' }] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 0))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Seni bekliyor$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^Sprint$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^Bağlam$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeTruthy()
  await ui.press({ key: 'now' })
  expect(sent).toEqual(["açık issue'lara bak, sıradaki işi öner"])
  await ui.unmount()
})
