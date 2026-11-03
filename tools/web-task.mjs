/** Independently read the requested counts from a model's final comparison.
 * Accept row-oriented or column-oriented Markdown tables, but never match
 * numbers across unrelated paragraphs or across the two dataset columns.
 */
export function reportedDatasetCounts(text) {
  const rows = String(text || '').split(/\r?\n/).filter((line) => line.trim().startsWith('|')).map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.replace(/[*`]/g, '').trim()))
  const iris = rows.findIndex((row) => row.some((cell) => /^Iris$/i.test(cell)))
  const wine = rows.findIndex((row) => row.some((cell) => /^Wine$/i.test(cell)))
  const number = (cell) => /^\d+$/.test(cell || '') ? Number(cell) : undefined
  if (iris < 0 || wine < 0) return {}
  if (iris === wine) {
    const irisColumn = rows[iris].findIndex((cell) => /^Iris$/i.test(cell))
    const wineColumn = rows[wine].findIndex((cell) => /^Wine$/i.test(cell))
    const instances = rows.find((row) => /Instances|样本数/i.test(row[0]))
    const features = rows.find((row) => /Features|特征数/i.test(row[0]))
    return { iris: { instances: number(instances?.[irisColumn]), features: number(features?.[irisColumn]) }, wine: { instances: number(instances?.[wineColumn]), features: number(features?.[wineColumn]) } }
  }
  const header = rows.find((row) => row.some((cell) => /Instances|样本数/i.test(cell)) && row.some((cell) => /Features|特征数/i.test(cell)))
  if (!header) return {}
  const instancesColumn = header.findIndex((cell) => /Instances|样本数/i.test(cell))
  const featuresColumn = header.findIndex((cell) => /Features|特征数/i.test(cell))
  return { iris: { instances: number(rows[iris][instancesColumn]), features: number(rows[iris][featuresColumn]) }, wine: { instances: number(rows[wine][instancesColumn]), features: number(rows[wine][featuresColumn]) } }
}

/** The exact final-answer predicates used by the live-site acceptance runner. */
export function evaluatePublicWebFinal(text) {
  const final = String(text || '')
  const reported = reportedDatasetCounts(final)
  const countsCorrect = reported.iris?.instances === 150 && reported.iris?.features === 4 && reported.wine?.instances === 178 && reported.wine?.features === 13
  const doisPresent = final.includes('10.24432/C56C76') && final.includes('10.24432/C5PC7J')
  return { ok: countsCorrect && doisPresent, countsCorrect, doisPresent }
}
