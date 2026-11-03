import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePublicWebFinal } from '../tools/web-task.mjs'

const columns = `| Dataset | Iris | Wine |
|---|---|---|
| Instances | **150** | **178** |
| Features | **4** | **13** |
| DOI | 10.24432/C56C76 | 10.24432/C5PC7J |`

test('both table orientations can report the requested facts and source DOIs', () => {
  const rows = `| Dataset | Instances | Features | DOI |
|---|---|---|---|
| Iris | 150 | 4 | 10.24432/C56C76 |
| Wine | 178 | 13 | 10.24432/C5PC7J |`
  for (const answer of [columns, rows]) assert.equal(evaluatePublicWebFinal(answer).ok, true)
})

test('an incorrect Iris sample count cannot pass despite otherwise correct facts', () => {
  const result = evaluatePublicWebFinal(columns.replace('**150**', '**151**'))
  assert.equal(result.ok, false)
  assert.equal(result.doisPresent, true)
})

test('an incorrect Wine feature count cannot borrow the Iris column value', () => {
  const result = evaluatePublicWebFinal(columns.replace('**13**', '**4**'))
  assert.equal(result.ok, false)
  assert.equal(result.doisPresent, true)
})

test('correct numbers in unrelated prose do not establish dataset attribution', () => {
  const answer = `Iris and Wine are public datasets. An unrelated note contains 150, 178, 4 and 13.
References: 10.24432/C56C76 and 10.24432/C5PC7J.`
  assert.equal(evaluatePublicWebFinal(answer).ok, false)
})

test('missing either source DOI prevents the final answer from passing', () => {
  for (const doi of ['10.24432/C56C76', '10.24432/C5PC7J']) {
    const result = evaluatePublicWebFinal(columns.replace(doi, 'Not reported'))
    assert.equal(result.ok, false)
    assert.equal(result.countsCorrect, true)
  }
})
