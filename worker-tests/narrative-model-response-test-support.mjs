// Transport fixtures only; these deterministic responses are not production narrative fallbacks.
const names = new Set([
  'analysis_candidate_narrative', 'analysis_target_narrative',
  'analysis_narrative_synthesis', 'analysis_narrative_grounding_review',
])

function requireFixture(condition, message) {
  if (!condition) throw new Error(message)
}

function referenceIds(rows) {
  const ids = rows.map(row => row.referenceId)
  requireFixture(ids.every(id => Number.isInteger(id) && id > 0), 'Narrative fixtures require trusted source reference IDs.')
  return [...new Set(ids)]
}

function claimReferences(ids, fallback) {
  const result = [...new Set(ids.length ? ids : fallback)]
  requireFixture(result.length > 0 && result.length <= 500, 'The narrative fixture claim needs bounded nonempty references.')
  return result
}

function checkRequiredReferences(outputClaims, source) {
  const retained = new Set(outputClaims.flatMap(claim => claim.referenceIds))
  requireFixture(source.requiredReferenceIds.every(id => retained.has(id)),
    'The narrative fixture omitted required source evidence.')
}

function candidateResponse(source) {
  const assessment = source.assessment
  const criteria = referenceIds(assessment.criteria)
  const supported = referenceIds(assessment.criteria.filter(row => row.evidenceStatus === 'supported'))
  const unresolved = referenceIds(assessment.criteria.filter(row => ['partial', 'missing', 'not-assessed'].includes(row.evidenceStatus)))
  const excluded = referenceIds(assessment.criteria.filter(row => row.evidenceStatus === 'not-applicable'))
  const qualifications = referenceIds(assessment.qualifications)
  const limitations = referenceIds(assessment.limitations)
  const withheld = assessment.overall.value.status === 'withheld'
  const sentences = [{
    text: supported.length
      ? 'The submitted document describes professional work relevant to the exact saved role requirements.'
      : 'The submitted document leaves the relevant professional work evidence incomplete or uncertain.',
    referenceIds: claimReferences(supported, criteria),
  }, {
    text: unresolved.length
      ? 'Partial, missing, or unassessed findings remain documentary gaps or uncertainties rather than judgments about personal ability.'
      : 'The documented examples are considered only within their stated responsibilities and outcomes.',
    referenceIds: claimReferences(unresolved, criteria),
  }, {
    text: qualifications.length && excluded.length
      ? 'Saved exclusions are preserved, and separate qualification alternatives remain unscored matters for human review.'
      : qualifications.length
        ? 'Separate qualification notes preserve the saved alternatives for unscored human review rather than an official eligibility decision.'
        : excluded.length
          ? 'The exact saved exclusions remain outside assessment rather than being described as missing evidence.'
          : 'Interpretation remains limited to the exact saved rubric and the submitted document evidence.',
    referenceIds: claimReferences([...excluded, ...qualifications], criteria),
  }]
  if (limitations.length || withheld) sentences.push({
    text: withheld
      ? 'Recorded limitations constrain interpretation of the work evidence, and the overall total remains withheld for human review.'
      : 'Recorded limitations constrain interpretation of the work evidence and need to remain visible during human review.',
    referenceIds: claimReferences([...limitations, ...(withheld ? [assessment.overall.referenceId] : [])], criteria),
  })
  const claims = sentences.map((sentence, sentenceIndex) => ({
    id: `fixture-text-${sentenceIndex}`, location: { field: 'text', sentenceIndex }, referenceIds: sentence.referenceIds,
  }))
  checkRequiredReferences(claims, source)
  const text = sentences.map(sentence => sentence.text).join(' ')
  const overview = 'The document-evidence review retains the saved requirements and unresolved findings for human review.'
  requireFixture(text.length <= 900 && overview.length <= 220, 'Candidate fixture prose exceeds the saved narrative budget.')
  return {
    text, overview,
    claims: [...claims, {
      id: 'fixture-overview', location: { field: 'overview', sentenceIndex: 0 },
      referenceIds: claimReferences(claims.flatMap(claim => claim.referenceIds), criteria),
    }],
  }
}

const findingText = {
  supported: 'The submitted evidence describes professional work relevant to the exact saved role requirements.',
  partial: 'Partial findings document bounded work evidence without establishing the full required scope.',
  missing: 'Missing findings indicate gaps in the submitted documents rather than an absence of personal ability.',
  'not-assessed': 'Unassessed findings leave the professional work evidence uncertain and require human review.',
  'not-applicable': 'The saved rubric excludes specified work rather than treating it as missing evidence.',
  qualifications: 'Separate qualification notes retain the saved alternatives and require unscored human review.',
  limitations: 'Recorded limitations constrain interpretation of the document evidence and require human review.',
  coverage: 'The completed reviews preserve saved evidence coverage without altering criterion weights.',
  available: 'The saved assessments retain their unchanged overall score availability for this exact target.',
  withheld: 'An overall total remains withheld where the saved assessment lacks safely assessable weighted evidence.',
  terminal: 'Failed or cancelled reviews remain unassessed and provide no evidence about personal ability.',
}

function cohortFindings(source) {
  const groups = new Map()
  function add(text, ids) {
    requireFixture(typeof text === 'string' && ids.every(id => Number.isInteger(id) && id > 0),
      'Cohort fixtures require complete findings and trusted reference IDs.')
    const previous = groups.get(text) ?? new Set()
    for (const id of ids) previous.add(id)
    groups.set(text, previous)
  }
  if (source.mode === 'saved-assessments') {
    for (const record of source.records) {
      if (!record.assessment) {
        requireFixture(['failed', 'cancelled'].includes(record.status), 'Only terminal unassessed records may omit assessment evidence.')
        add(findingText.terminal, [record.statusReferenceId])
        continue
      }
      const assessment = record.assessment
      for (const row of assessment.criteria) add(findingText[row.evidenceStatus], [row.referenceId])
      if (assessment.qualifications.length) add(findingText.qualifications, referenceIds(assessment.qualifications))
      if (assessment.limitations.length) add(findingText.limitations, referenceIds(assessment.limitations))
      add(findingText.coverage, [record.statusReferenceId, assessment.coverage.referenceId])
      add(findingText[assessment.overall.value.status], [assessment.overall.referenceId])
    }
  } else {
    requireFixture(source.mode === 'reviewed-synthesis', 'Unknown narrative fixture synthesis context.')
    for (const node of source.nodes) for (const finding of node.output.findings) add(finding.text, finding.referenceIds)
  }
  const findings = []
  for (const [text, ids] of groups) {
    const values = [...ids]
    for (let offset = 0; offset < values.length; offset += 500) {
      findings.push({ id: `fixture-finding-${findings.length}`, text, referenceIds: values.slice(offset, offset + 500) })
    }
  }
  checkRequiredReferences(findings, source)
  return findings
}

function targetResponse(source) {
  const paragraphs = []
  const claims = []
  let sentenceIndex = 0
  for (const finding of cohortFindings(source)) {
    const paragraph = paragraphs.at(-1)
    if (!paragraph || paragraph.length + 1 + finding.text.length > 900) {
      paragraphs.push(finding.text)
      sentenceIndex = 0
    } else paragraphs[paragraphs.length - 1] += ` ${finding.text}`
    claims.push({
      id: `fixture-target-${claims.length}`,
      location: { field: 'paragraphs', paragraphIndex: paragraphs.length - 1, sentenceIndex: sentenceIndex++ },
      referenceIds: finding.referenceIds,
    })
  }
  requireFixture(paragraphs.length > 0 && paragraphs.length <= 3 && paragraphs.join('\n\n').length <= 2400 && claims.length <= 32,
    'This test corpus needs a custom bounded narrative response fixture.')
  return { paragraphs, claims }
}

export function narrativeModelTestResponseFor(kind, body) {
  if (!names.has(kind)) return undefined
  if (kind === 'analysis_narrative_grounding_review') return { outcome: 'supported', issues: [] }
  if (kind === 'analysis_candidate_narrative') return candidateResponse(body.source)
  if (kind === 'analysis_target_narrative') return targetResponse(body.source)
  const output = { members: [...body.source.members], findings: cohortFindings(body.source) }
  requireFixture(Buffer.byteLength(JSON.stringify(output)) <= body.source.outputByteLimit,
    'This test corpus needs a smaller custom synthesis fixture.')
  return output
}

// Undefined means the request belongs to the caller's existing scoring/other model fake.
export function narrativeModelTestResponse(request) {
  const kind = request.response_format.json_schema.name
  if (!names.has(kind)) return undefined
  return narrativeModelTestResponseFor(kind, JSON.parse(request.messages[1].content))
}
