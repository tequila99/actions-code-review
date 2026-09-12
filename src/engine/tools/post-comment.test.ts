import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postComment, createCommentAccumulator, buildPostCommentSpec } from './post-comment.ts'
import { makeToolContext } from '../../../test/helpers/tool-context.ts'
import { withTmpWorkspace } from '../../../test/helpers/tmp-workspace.ts'

const VALID_ARGS = {
  path: 'src/a.ts',
  line: 10,
  severity: 'high',
  category: 'correctness',
  message: 'looks wrong'
}

test('T7.28: post_comment accumulates without publishing immediately', async () => {
  const comments = createCommentAccumulator(10)
  const ctx = makeToolContext('/tmp/whatever', { comments })
  const result = await postComment(VALID_ARGS, ctx)
  assert.equal(result.isError, false)
  assert.equal(comments.findings.length, 1)
  assert.deepEqual(comments.findings[0], {
    path: 'src/a.ts',
    line: 10,
    severity: 'high',
    category: 'correctness',
    message: 'looks wrong'
  })
})

test('T7.29: invalid arguments are a result-error the model can retry from', async () => {
  const comments = createCommentAccumulator(10)
  const ctx = makeToolContext('/tmp/whatever', { comments })
  const result = await postComment({ ...VALID_ARGS, severity: 'critical', line: -1 }, ctx)
  assert.equal(result.isError, true)
  assert.match(result.content, /severity/)
  assert.match(result.content, /line/)
  assert.equal(comments.findings.length, 0)
})

test('T7.30: the 3x max_comments safety cap refuses further comments once reached', async () => {
  const comments = createCommentAccumulator(2)
  const ctx = makeToolContext('/tmp/whatever', { comments })
  await postComment({ ...VALID_ARGS, path: 'a.ts', line: 1 }, ctx)
  await postComment({ ...VALID_ARGS, path: 'a.ts', line: 2 }, ctx)
  const result = await postComment({ ...VALID_ARGS, path: 'a.ts', line: 3 }, ctx)
  assert.equal(result.isError, true)
  assert.match(result.content, /limit/)
  assert.equal(comments.findings.length, 2)
})

test('T7.31: a duplicate comment on the same path+line is deduplicated', async () => {
  const comments = createCommentAccumulator(10)
  const ctx = makeToolContext('/tmp/whatever', { comments })
  await postComment(VALID_ARGS, ctx)
  const result = await postComment({ ...VALID_ARGS, message: 'different text' }, ctx)
  assert.equal(result.isError, false)
  assert.match(result.content, /duplicate/)
  assert.equal(comments.findings.length, 1)
})

test('TI.1: suggestion without original_snippet (or vice versa) — isError true, finding recorded without a suggestion', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', 'const x = 1\n')
    const comments = createCommentAccumulator(10)
    const ctx = makeToolContext(ws.root, { comments })

    const result = await postComment({ ...VALID_ARGS, suggestion: 'const x = 2' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content, /original_snippet/)
    assert.equal(comments.findings.length, 1)
    assert.equal(comments.findings[0]!.suggestion, undefined)
  })
})

test('TI.2: original_snippet does not match the file on disk — isError true, suggestion dropped, finding still recorded', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', 'const x = 1\n')
    const comments = createCommentAccumulator(10)
    const ctx = makeToolContext(ws.root, { comments })

    const result = await postComment(
      { ...VALID_ARGS, path: 'src/a.ts', line: 1, original_snippet: 'const x = 999', suggestion: 'const x = 2' },
      ctx
    )
    assert.equal(result.isError, true)
    assert.match(result.content, /re-read/)
    assert.equal(comments.findings.length, 1)
    assert.equal(comments.findings[0]!.suggestion, undefined)
  })
})

test('TI.2c: original_snippet provided for a nonexistent file — treated as a mismatch, not a crash', async () => {
  await withTmpWorkspace(async (ws) => {
    const comments = createCommentAccumulator(10)
    const ctx = makeToolContext(ws.root, { comments })

    const result = await postComment(
      { ...VALID_ARGS, path: 'missing.ts', line: 1, original_snippet: 'x', suggestion: 'y' },
      ctx
    )
    assert.equal(result.isError, true)
    assert.match(result.content, /re-read/)
    assert.equal(comments.findings.length, 1)
    assert.equal(comments.findings[0]!.suggestion, undefined)
  })
})

test('TI.2d: original_snippet with an out-of-range line — treated as a mismatch, not a crash', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', 'one line only\n')
    const comments = createCommentAccumulator(10)
    const ctx = makeToolContext(ws.root, { comments })

    const result = await postComment(
      { ...VALID_ARGS, path: 'src/a.ts', line: 50, original_snippet: 'x', suggestion: 'y' },
      ctx
    )
    assert.equal(result.isError, true)
    assert.match(result.content, /re-read/)
    assert.equal(comments.findings[0]!.suggestion, undefined)
  })
})

test('TI.3: original_snippet matches exactly — suggestion is accepted onto the finding', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', 'const x = 1\n')
    const comments = createCommentAccumulator(10)
    const ctx = makeToolContext(ws.root, { comments })

    const result = await postComment(
      { ...VALID_ARGS, path: 'src/a.ts', line: 1, original_snippet: 'const x = 1', suggestion: 'const x = 2' },
      ctx
    )
    assert.equal(result.isError, false)
    assert.equal(comments.findings.length, 1)
    assert.equal(comments.findings[0]!.suggestion, 'const x = 2')
  })
})

test('TI.3b: original_snippet matches exactly across a multi-line range', async () => {
  await withTmpWorkspace(async (ws) => {
    await ws.write('src/a.ts', 'one\ntwo\nthree\n')
    const comments = createCommentAccumulator(10)
    const ctx = makeToolContext(ws.root, { comments })

    const result = await postComment(
      {
        ...VALID_ARGS,
        path: 'src/a.ts',
        line: 1,
        end_line: 2,
        original_snippet: 'one\ntwo',
        suggestion: 'ONE\nTWO'
      },
      ctx
    )
    assert.equal(result.isError, false)
    assert.equal(comments.findings[0]!.suggestion, 'ONE\nTWO')
  })
})

test('TI.4: agent.allow_suggestions: false — original_snippet/suggestion are absent from the tool spec entirely', () => {
  const spec = buildPostCommentSpec(false)
  const properties = spec.parameters.properties as Record<string, unknown>
  assert.equal('original_snippet' in properties, false)
  assert.equal('suggestion' in properties, false)
})

test('TI.4b: agent.allow_suggestions: true (default) — original_snippet/suggestion are present in the tool spec', () => {
  const spec = buildPostCommentSpec(true)
  const properties = spec.parameters.properties as Record<string, unknown>
  assert.ok('original_snippet' in properties)
  assert.ok('suggestion' in properties)
})
