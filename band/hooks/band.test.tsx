import { expect, test } from 'claude-code/testing'
import { DEFAULTS, quickPromptsOf, tasksOf } from './register.tsx'

const BAND = {
  plugin: 'imprimatur-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 100 },
} as const

const WWLO = {
  tasks: [
    { key: '#206', pointer_title: 'Add the band', pointer_owner: 'C' },
    { key: '#176', pointer_title: 'Send the PDFs', pointer_owner: 'K' },
    { key: 'AUTOPILOT', pointer_title: null },
  ],
}

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

test('the first task with a 👉 leads; tasks whose 👉 is the user\'s are counted', async () => {
  expect(tasksOf(WWLO)).toEqual({ task: { key: '#206', step: 'Add the band' }, waiting: 1 })
  expect(tasksOf(undefined)).toEqual({ task: undefined, waiting: 0 })
})

test('the band shows the task, what waits, git and the prompts; a press sends', async ($, on) => {
  const sent: string[] = []
  on('fs.read', () => ({ value: JSON.stringify({ quickPrompts: [{ label: 'Durum', text: 'neredeyiz?' }] }) }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: JSON.stringify(WWLO) }], isError: false } }))
  const argvs: string[][] = []
  on('process.run', (_, e: any) => (argvs.push(e.argv), {
    value: e.argv.includes('status') ? { exitCode: 0, stdout: ' M a.ts\n', stderr: '' } : { exitCode: 0, stdout: '2\n', stderr: '' },
  }))
  on('prompt.submit', (_, e: any) => (sent.push(e.text), {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({}))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 0))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Seni bekliyor: 1/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /1 değişiklik · 2 commit/ }))).toBeTruthy()
    await ui.press({ key: 'p0' })
    await ui.press({ key: 'task' })
    await ui.unmount()
  }
  expect(sent.slice(0, 2)).toEqual(['neredeyiz?', 'devam et: #206'])
  // git runs no program a cloned repo's config names
  expect(argvs.length > 0 && argvs.every(a => a.includes('core.fsmonitor=false') && a.includes('core.hooksPath=/dev/null'))).toBe(true)
})
