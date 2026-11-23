import { expect, test } from 'claude-code/testing'
import { DEFAULTS, doneOf, quickPromptsOf, sprintOf, workOf } from './register.tsx'

const BAND = {
  plugin: 'imprimatur-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 100 },
} as const

const WWLO = {
  tasks: [
    { key: 'AUTOPILOT', status: 'active', title: 'Setup autopilot', summary: 'Last run: 3 fixed' },
    { key: '#206', status: 'open', title: 'Band', pointer_title: 'Add the band', pointer_owner: 'C' },
    { key: '#176', status: 'open', title: 'PDFs', pointer_title: 'Send the PDFs', pointer_owner: 'K' },
    { key: 'X', status: 'active', title: 'Rewrite X', summary: 'tests left' },
    { key: 'UI', status: 'open', title: '' },
    { key: '#236', status: 'open', title: 'Health-check report' },
  ],
}
const DONE = { tasks: [{ key: 'AUTOPILOT', title: 'old' }, { key: 'BAND', title: 'Band rebuilt' }, { key: '#165', title: 'Links' }, { key: '#1', title: 'Older' }] }

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

test('open is what is in progress, next the first open task not started, the user\'s apart; AUTOPILOT and untitled left out', async () => {
  expect(workOf(WWLO)).toEqual({
    open: [{ key: '#206', text: 'Add the band' }, { key: 'X', text: 'tests left' }],
    next: { key: '#236', text: 'Health-check report' },
    waiting: [{ key: '#176', text: 'Send the PDFs' }],
  })
  expect(workOf(undefined)).toEqual({ open: [], next: undefined, waiting: [] })
})

test('done: the latest two, AUTOPILOT left out', async () => {
  expect(doneOf(DONE)).toEqual([{ key: 'BAND', text: 'Band rebuilt' }, { key: '#165', text: 'Links' }])
})

test('the sprint due first, named alone, with days left; a past one counts days since', async () => {
  const now = Date.parse('2026-11-23T12:00:00Z')
  const ms = [
    { title: 'Sprint 10', state: 'open', due_on: '2026-12-04T00:00:00Z', open_issues: 2, closed_issues: 0 },
    { title: 'Sprint 9 · Nov 24–30 · Theme', state: 'open', due_on: '2026-11-27T00:00:00Z', open_issues: 11, closed_issues: 1 },
    { title: 'Backlog', state: 'open', due_on: null, open_issues: 5, closed_issues: 0 },
  ]
  expect(sprintOf(ms, now)).toEqual({ title: 'Sprint 9', closed: 1, total: 12, daysLeft: 4 })
  expect(sprintOf([{ title: 'Sprint 5', state: 'open', due_on: '2026-11-09T00:00:00Z', open_issues: 0, closed_issues: 31 }], now)?.daysLeft).toBe(-14)
  expect(sprintOf('nope', now)).toBe(undefined)
})

function fake(on: any, o: { wwlo?: any; done?: any; ms?: any; percent?: number; sent: string[]; calls?: any[] }) {
  on('fs.read', () => ({ value: '{}' }))
  on('clock.now', () => ({ value: Date.parse('2026-11-23T12:00:00Z') }))
  on('clock.sleep', () => ({ value: undefined }))
  on('mcp.call', (_: any, e: any) => {
    o.calls?.push(e)
    const a = e.tool === 'task_list' ? o.done : o.wwlo
    return { value: a === undefined ? { content: [], isError: true } : { content: [{ type: 'text', text: JSON.stringify(a) }], isError: false } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(o.ms ?? []), stderr: '' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { percent: o.percent ?? 10 } } }))
  on('prompt.submit', (_: any, e: any) => (o.sent.push(e.text), { text: e.text }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({}))
}

test('the band: done, open, next, the user\'s, a past sprint, context; every key starts its work', async ($, on) => {
  const sent: string[] = []
  const calls: any[] = []
  fake(on, {
    wwlo: WWLO, done: DONE, sent, calls, percent: 82,
    ms: [{ title: 'Sprint 5 · Nov 4–10 · x', state: 'open', due_on: '2026-11-09T00:00:00Z', open_issues: 0, closed_issues: 31 }],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 0))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    for (const t of [/^Bitti$/, /^Açık$/, /^Sıradaki$/, /%82 dolu/]) expect(await ui.find({ type: 'Text', text: t })).toBeTruthy()
    // a short key button, its text apart beside it
    for (const l of [/^BAND$/, /^#206$/, /^#236$/, /^planla$/]) expect(await ui.find({ type: 'Button', text: l })).toBeTruthy()
    for (const t of [/^Band rebuilt$/, /^Add the band$/, /^Health-check report$/, /^Sprint 5 bitti, 14 gün önce$/])
      expect(await ui.find({ type: 'Text', text: t })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Last run/ })).toBeFalsy()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  for (const key of ['d0', 'o0', 'next', 'w0', 'sprint', 'p1']) await ui.press({ key })
  expect(sent).toEqual([
    'BAND ne getirdi, kısaca özetle',
    'devam et: #206',
    'başla: #236',
    '#176: bende bekleyen adımı göster ve birlikte yapalım',
    'yeni sprint planla',
    DEFAULTS[1].text,
  ])
  await ui.unmount()
  // the done list is asked for a few tasks, not every one ever done
  expect(calls.find(c => c.tool === 'task_list')?.args).toEqual({ status: 'done', limit: 4 })
})

test('Imprimatur not answering yet is not "no work": no task row is made up', async ($, on) => {
  const sent: string[] = []
  fake(on, { sent })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 0))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /açık iş yok/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^Sıradaki$/ })).toBeFalsy()
  await ui.unmount()
})

test('nothing open: "seç" asks for the next work; empty rows hidden', async ($, on) => {
  const sent: string[] = []
  fake(on, { wwlo: { tasks: [] }, done: { tasks: [] }, sent })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 0))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  for (const t of [/^Bitti$/, /^Açık$/, /^Sende$/, /^Sprint$/, /^Bağlam$/]) expect(await ui.find({ type: 'Text', text: t })).toBeFalsy()
  await ui.press({ key: 'next' })
  expect(sent).toEqual(["açık issue'lara bak, sıradaki işi öner ve başla"])
  await ui.unmount()
})
