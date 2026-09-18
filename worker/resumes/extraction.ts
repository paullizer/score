import { JSDOM } from 'jsdom'
import { RESUME_IMPORT_LIMITS } from '../../src/domain/real-resumes'
import type { ResumeProcessingErrorCode } from '../../src/domain/real-resumes'
import type { DocumentParagraph } from '../../src/domain/types'
import {
  createParagraphs,
  documentIntelligenceParagraphs,
  normalizeText,
  validatePublicUrl,
  WorkerError,
} from '../runtime'
import type { DocumentIntelligenceResult, ParagraphOptions } from '../runtime'

export class ResumeExtractionError extends Error {
  constructor(
    readonly code: ResumeProcessingErrorCode,
    message: string,
    readonly retryable = false,
    readonly stage: 'download' | 'parsing' = 'parsing',
  ) {
    super(message)
    this.name = 'ResumeExtractionError'
  }
}

export class ResumeHtmlShellError extends ResumeExtractionError {
  readonly requiresRendering = true

  constructor() {
    super('unreadable-document', 'This page requires public JavaScript rendering before its profile can be read.')
    this.name = 'ResumeHtmlShellError'
  }
}

const RESUME_SECTIONS = /^(?:(?:professional|personal|career|executive)\s+(?:profile|summary)|profile|summary|about(?: me)?|contact(?: details| information)?|(?:professional |work |relevant |research |teaching |volunteer )?experience|employment(?: history)?|career history|education(?: and training)?|qualifications|(?:technical |professional |core )?skills|competencies|certifications|credentials|projects|publications|awards(?: and honors)?|honors|languages|volunteering|interests|references):?$/i
const PARAGRAPH_OPTIONS: ParagraphOptions = {
  defaultHeading: 'Resume',
  maxPages: RESUME_IMPORT_LIMITS.maxPdfPages,
  maxCharacters: RESUME_IMPORT_LIMITS.maxSourceCharacters,
  minimumTextLength: 1,
  emptySourceMessage: 'The source did not contain readable resume text.',
}
export { RESUME_SECTIONS, PARAGRAPH_OPTIONS as RESUME_PARAGRAPH_OPTIONS }
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'OL', 'P',
  'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL',
])
const CONTROL_TEXT = /^(?:(?:sign[ -]?in|log[ -]?in|sign[ -]?up|join now|register|connect|follow|share|message|view (?:full )?profile)(?:\s+(?:to|with|for|on)\b.*)?|(?:privacy|cookie) policy|terms(?: of (?:use|service))?|accept(?: all)? cookies|reject(?: all)? cookies|manage (?:cookies|preferences)|skip to (?:main )?content)[.!]?$/i
const PROFESSIONAL_TEXT = /\b(?:experience|education|employment|career|skills|certifi(?:ed|cation)|credentials|portfolio|publications|research|engineer|developer|designer|analyst|manager|director|consultant|specialist|scientist|professor|teacher|educator|nurse|physician|doctor|therapist|attorney|lawyer|counsel|accountant|architect|technician|electrician|carpenter|plumber|chef|artist|writer|editor|journalist|librarian|veterinarian|dentist|pharmacist|strategist|entrepreneur|founder|president|officer|assistant|coordinator|administrator|recruiter|sales|marketing|operations)\b/i
const DIRECTORY_HEADING = /^(?:(?:(?:our|the|meet (?:our|the))\s+)?(?:team|staff|people|members|professionals|resumes|profiles|directory|people directory|staff directory|member directory)(?:\s*[:|—–-].*)?|search results(?:\s+for\b.*)?)$/i
const SHELL_PLACEHOLDER = /^(?:loading(?: (?:profile|resume|page|application|app))?|please wait|(?:please |you need to )?enable javascript to (?:run|use) (?:this|the) (?:app|application))[.!…]*$/i

type JsonRecord = Record<string, unknown>
type Block = { text: string; heading?: string }

function parsingError(error: unknown): never {
  if (error instanceof ResumeExtractionError) throw error
  if (error instanceof WorkerError) {
    if (error.code === 'source-too-long') {
      throw new ResumeExtractionError('source-too-large', `The extracted resume exceeds ${RESUME_IMPORT_LIMITS.maxSourceCharacters} characters.`)
    }
    if (error.code === 'pdf-too-many-pages') {
      throw new ResumeExtractionError('pdf-too-many-pages', `PDF exceeds the ${RESUME_IMPORT_LIMITS.maxPdfPages}-page limit.`)
    }
    if (error.code === 'ocr-invalid-response') {
      throw new ResumeExtractionError('service-unavailable', 'The document extraction service returned an incomplete result. Please retry.', true)
    }
    if (error.code === 'ocr-invalid-page') {
      throw new ResumeExtractionError('unreadable-document', 'The PDF text could not be reliably assigned to its original pages.')
    }
    if (error.code === 'invalid-url') {
      throw new ResumeExtractionError('invalid-source', 'A public HTTP or HTTPS source URL without credentials is required.', false, 'download')
    }
    if (error.code === 'empty-source') {
      throw new ResumeExtractionError('unreadable-document', 'The source did not contain readable resume text.')
    }
  }
  throw error
}

/** Uses original OCR page locators, never synthetic pagination or job section defaults. */
export function documentIntelligenceResumeParagraphs(result: DocumentIntelligenceResult): DocumentParagraph[] {
  if (result.status !== 'succeeded') {
    throw new ResumeExtractionError(
      result.status === 'failed' ? 'unreadable-document' : 'service-unavailable',
      result.status === 'failed' ? 'The PDF could not be read.' : 'Document extraction has not completed. Please retry.',
      result.status !== 'failed',
    )
  }
  try {
    return documentIntelligenceParagraphs(result, {
      ...PARAGRAPH_OPTIONS,
      sectionHeadingPattern: RESUME_SECTIONS,
      requirePageNumbers: true,
    })
  } catch (error) {
    return parsingError(error)
  }
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasType(value: JsonRecord, type: string): boolean {
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']]
  return types.some(candidate => typeof candidate === 'string' && candidate.split(/[/#:]/).at(-1) === type)
}

function multipleProfiles(): never {
  throw new ResumeExtractionError('multiple-profiles', 'This source contains multiple profiles or a people directory. Import one person’s profile per URL.')
}

function structuredProfile(scripts: string[], url: string): {
  person?: JsonRecord
  resolve: (value: JsonRecord) => JsonRecord
  unrelated: boolean
  warnings: string[]
} {
  const records: JsonRecord[] = []
  const warnings: string[] = []
  for (const script of scripts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(script)
    } catch {
      warnings.push('Some structured profile data was unreadable; only readable source content was retained.')
      continue
    }
    const queue: unknown[] = [parsed]
    for (let index = 0; index < queue.length; index += 1) {
      const value = queue[index]
      if (Array.isArray(value)) {
        for (const item of value) queue.push(item)
      }
      else if (record(value)) {
        records.push(value)
        queue.push(...Object.values(value).filter(child => child !== null && typeof child === 'object'))
      }
    }
  }
  const absoluteId = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value) return undefined
    try { return new URL(value, url).href } catch { return undefined }
  }
  const byId = new Map<string, JsonRecord>()
  for (const value of records) {
    const id = absoluteId(value['@id'])
    if (id) byId.set(id, { ...byId.get(id), ...value })
  }
  const resolve = (value: JsonRecord): JsonRecord => ({ ...byId.get(absoluteId(value['@id']) ?? ''), ...value })
  const key = (value: JsonRecord): string => absoluteId(value['@id']) ?? JSON.stringify(value)
  const objects = (value: unknown): JsonRecord[] => (Array.isArray(value) ? value : [value])
    .map(item => typeof item === 'string' ? { '@id': item } : item).filter(record).map(resolve)
  const unique = (values: JsonRecord[]): JsonRecord[] => [...new Map(values.map(value => [key(value), value])).values()]
  const pages = records.filter(value => hasType(value, 'ProfilePage') || hasType(value, 'WebPage'))
  const mainPeople = unique(pages.flatMap(page => objects(page.mainEntity)).filter(value => hasType(value, 'Person')))
  if (mainPeople.length > 1) multipleProfiles()

  const incidental = new Set<string>()
  for (const value of records) {
    for (const field of ['author', 'creator', 'publisher', 'contributor', 'reviewedBy', 'mentions']) {
      for (const person of objects(value[field])) incidental.add(key(person))
    }
  }
  const people = unique(records.map(resolve).filter(value => hasType(value, 'Person') && !incidental.has(key(value))))
  const unrelated = records.some(value => ['JobPosting', 'Article', 'NewsArticle', 'BlogPosting', 'Product', 'Recipe'].some(type => hasType(value, type)))
  if (!mainPeople.length && unrelated && !pages.some(value => hasType(value, 'ProfilePage'))) {
    return { resolve, unrelated: true, warnings }
  }
  const declaredMain = people.filter(person => {
    const page = person.mainEntityOfPage
    const id = absoluteId(record(page) ? page['@id'] : page)
    return id?.split('#')[0] === url.split('#')[0]
  })
  const candidates = mainPeople.length ? mainPeople : declaredMain.length ? declaredMain : people
  if (candidates.length > 1) multipleProfiles()
  return { person: candidates[0], resolve, unrelated: unrelated && !candidates.length, warnings }
}

function removeNonContent(root: ParentNode): void {
  root.querySelectorAll('script,style,noscript,template,svg,canvas,iframe,object,embed,nav,menu,[role="navigation"],[hidden],[aria-hidden="true" i]').forEach(element => element.remove())
  root.querySelectorAll('[style]').forEach(element => {
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(element.getAttribute('style') ?? '')) element.remove()
  })
  for (const element of root.querySelectorAll('aside,section')) {
    const heading = element.querySelector('h1,h2,h3,h4')
    if (/^(?:people also viewed|similar profiles|related profiles|recommended (?:people|profiles)|other people|you may also (?:like|know))$/i.test(normalizeText(heading?.textContent ?? ''))) element.remove()
  }
}

function contentRoot(document: Document): Element {
  return document.querySelector('main,[role="main"]') ?? document.body
}

function checkAccess(document: Document, root = contentRoot(document)): void {
  const headings = [document.title, ...Array.from(root.querySelectorAll('h1'), element => element.textContent ?? '')].map(normalizeText)
  const wallHeading = /(?:\baccess denied\b|\b403 forbidden\b|\bsecurity (?:check|verification)\b|\brobot check\b|\bverify (?:that )?you(?: are|'re) (?:a )?human\b|\bare you (?:a )?human\b|\bchecking your browser\b|\bjust a moment\b|\b(?:profile|page) (?:is )?private\b|\b(?:consent|authentication|cookies) required\b|^before you continue\b|(?:^|[|:—–-]\s*)(?:sign[ -]?in|log[ -]?in|login|sign[ -]?up)(?:\b|[.!])|\blog in or sign up\b)/i
  const wallMessage = /^(?:(?:(?:please|you (?:must|need to))\s+)?(?:sign[ -]?in|log[ -]?in|join|register|create an account)\b.{0,90}\b(?:view|access|continue)\b|(?:this|the|that) (?:profile|page|content) (?:is (?:private|unavailable|restricted)|is not (?:public|available)|isn't (?:public|available))|you (?:do not|don't) have (?:permission|access)|(?:sorry[,.]?\s+)?you(?: have been|'ve been| are) blocked|(?:please\s+)?(?:verify (?:that )?you(?: are|'re) (?:a human|human|not a robot)|complete (?:the|a) (?:captcha|security check))|(?:enable|please enable) (?:cookies|javascript|js)(?: and cookies)? (?:to continue|and disable)|authentication required|permission denied)/i
  const text = normalizeText(root.textContent ?? '')
  const messages = [text, ...Array.from(root.querySelectorAll('p,h2,[role="alert"]'), element => normalizeText(element.textContent ?? ''))]
  const passwordForm = Array.from(root.querySelectorAll('input[type="password" i]')).some(element => !element.closest('header'))
  if (headings.some(heading => wallHeading.test(heading)) ||
      messages.some(message => wallMessage.test(message)) ||
      (passwordForm && text.length < 1_200)) {
    throw new ResumeExtractionError('access-blocked', 'This URL is not publicly accessible and could not be processed.', false, 'download')
  }
}

function removeControls(root: ParentNode): void {
  root.querySelectorAll('form,button,input,select,textarea,[role="dialog"],[role="button"]').forEach(element => element.remove())
  for (const element of root.querySelectorAll('a')) {
    if (CONTROL_TEXT.test(normalizeText(element.textContent ?? ''))) element.remove()
  }
}

function inlineText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? ''
  if (node.nodeType === 1 && (node as Element).tagName === 'BR') return '\n'
  return Array.from(node.childNodes, inlineText).join('')
}

function readableBlocks(root: Node, initialHeading = 'Profile'): Block[] {
  const blocks: Block[] = []
  let heading = initialHeading
  const add = (value: string): void => {
    const text = normalizeText(value)
    if (!/[\p{L}\p{N}]/u.test(text) || CONTROL_TEXT.test(text) ||
        /^(?:©|copyright\b|we use cookies\b|this (?:site|website) uses cookies\b)/i.test(text)) return
    blocks.push({ text, heading })
  }
  const visit = (node: Node): void => {
    if (node.nodeType === 1) {
      const element = node as Element
      if (/^H[1-6]$/.test(element.tagName)) {
        const text = normalizeText(inlineText(element))
        if (text && !CONTROL_TEXT.test(text)) {
          heading = text
          add(text)
        }
        return
      }
      if (element.tagName === 'TR') {
        add(Array.from(element.children, child => normalizeText(inlineText(child))).filter(Boolean).join(' | '))
        return
      }
    }
    let buffer = ''
    for (const child of node.childNodes) {
      if (child.nodeType === 1 && BLOCK_TAGS.has((child as Element).tagName)) {
        add(buffer)
        buffer = ''
        visit(child)
      } else {
        buffer += inlineText(child)
      }
    }
    add(buffer)
  }
  visit(root)
  return blocks
}

function fieldStrings(value: unknown, resolve: (value: JsonRecord) => JsonRecord): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(item => fieldStrings(item, resolve))
  if (!record(value)) return []
  const resolved = resolve(value)
  const label = resolved.name ?? resolved.value ?? resolved.text
  if (typeof label === 'string') return [label]
  return ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']
    .flatMap(field => {
      const part = resolved[field]
      return typeof part === 'string' ? [part] : record(part) && typeof part.name === 'string' ? [part.name] : []
    })
}

function personBlocks(person: JsonRecord | undefined, resolve: (value: JsonRecord) => JsonRecord): Block[] {
  if (!person) return []
  const blocks: Block[] = []
  for (const [field, heading] of [
    ['name', 'Name'], ['givenName', 'Name'], ['familyName', 'Name'], ['jobTitle', 'Role'], ['hasOccupation', 'Role'],
    ['description', 'Summary'], ['worksFor', 'Experience'], ['affiliation', 'Experience'], ['alumniOf', 'Education'],
    ['knowsAbout', 'Skills'], ['knowsLanguage', 'Languages'], ['hasCredential', 'Credentials'], ['award', 'Awards'],
    ['address', 'Location'], ['homeLocation', 'Location'], ['workLocation', 'Location'], ['email', 'Contact'], ['telephone', 'Contact'],
  ]) {
    if ((field === 'givenName' || field === 'familyName') && typeof person.name === 'string') continue
    for (const value of fieldStrings(person[field], resolve)) {
      const fragment = JSDOM.fragment(value)
      removeNonContent(fragment)
      removeControls(fragment)
      blocks.push(...readableBlocks(fragment, heading))
    }
  }
  return blocks
}

function looksLikeName(text: string): boolean {
  return text.length < 100 && /^(?:[\p{L}\p{M}.'’—-]+\s+){1,5}[\p{L}\p{M}.'’—-]+$/u.test(text) &&
    !/\b(?:privacy|policy|terms|guide|template|tips|news|welcome|services|products|contact|about|experience|education|skills|resume|profile)\b/i.test(text)
}

function checkSingleProfile(root: Element, person: JsonRecord | undefined): void {
  const primaryHeading = root.querySelector('h1')
  const title = normalizeText(primaryHeading?.textContent ?? '')
  if (DIRECTORY_HEADING.test(title)) multipleProfiles()
  const markedPeople = Array.from(root.querySelectorAll('[itemtype]')).filter(element =>
    (element.getAttribute('itemtype') ?? '').split(/\s+/).some(type => /schema\.org\/Person$/.test(type)) &&
    !element.parentElement?.closest('[itemtype$="/Person"]'))
  if (markedPeople.length > 1) multipleProfiles()
  if (!person && (!looksLikeName(title) || primaryHeading?.closest('article'))) {
    const cards = Array.from(root.querySelectorAll('article')).filter(article =>
      looksLikeName(normalizeText(article.querySelector('h1,h2,h3')?.textContent ?? '')) &&
      PROFESSIONAL_TEXT.test(readableBlocks(article).map(block => block.text).join('\n')))
    if (cards.length > 1) multipleProfiles()
  }
}

/** HTML pages use section labels and page=1; the caller records pagination as html-sections. */
export function extractResumeHtml(html: string, url: string): {
  title: string
  paragraphs: DocumentParagraph[]
  thin: boolean
  warnings: string[]
} {
  if (Buffer.byteLength(html, 'utf8') > RESUME_IMPORT_LIMITS.maxPdfBytes) {
    throw new ResumeExtractionError('source-too-large', 'The HTML source exceeds the 10 MiB source limit.')
  }
  if (url.length > RESUME_IMPORT_LIMITS.maxUrlLength) {
    throw new ResumeExtractionError('invalid-source', 'The source URL exceeds the supported length.', false, 'download')
  }
  let dom: JSDOM | undefined
  try {
    const sourceUrl = validatePublicUrl(url).href
    dom = new JSDOM(html, { url: sourceUrl })
    const document = dom.window.document
    // Inspect access walls before accepting even otherwise valid Person metadata.
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json" i]'), script => script.textContent ?? '')
    const executableScripts = Array.from(document.querySelectorAll('script')).filter(script =>
      ['', 'module', 'text/javascript', 'application/javascript'].includes((script.getAttribute('type') ?? '').trim().toLowerCase()) &&
      Boolean(script.getAttribute('src')?.trim() || script.textContent?.trim()))
    const hasScript = executableScripts.length > 0
    const hasGateScript = executableScripts.some(script =>
      /captcha|challenge|authwall|(?:^|[/_.-])(?:login|signin|sign-in)(?:[/_.?-]|$)/i.test(
        `${script.id} ${script.getAttribute('src') ?? ''} ${script.textContent ?? ''}`,
      ))
    removeNonContent(document)
    checkAccess(document)
    const visibleRoot = contentRoot(document)
    const rootText = normalizeText(inlineText(visibleRoot)).replace(/\s+/g, ' ')
    if (hasScript && (!rootText || SHELL_PLACEHOLDER.test(rootText))) checkAccess(document, document.body)
    const shellText = normalizeText(inlineText(document.body)).replace(/\s+/g, ' ')
    const emptyShell = hasScript && !document.body.querySelector('form,input') &&
      (!shellText || (shellText.length < 160 && SHELL_PLACEHOLDER.test(shellText)))
    const gatePath = /(?:^|\/)(?:login|signin|sign-in|authwall|challenge|captcha)(?:\/|$)/i.test(new URL(sourceUrl).pathname)
    if (emptyShell && (hasGateScript || gatePath)) {
      throw new ResumeExtractionError('access-blocked', 'This URL is not publicly accessible and could not be processed.', false, 'download')
    }
    const structured = structuredProfile(scripts, sourceUrl)
    removeControls(document)
    const root = contentRoot(document)
    checkSingleProfile(root, structured.person)
    const readable = readableBlocks(root)
    const structuredBlocks = personBlocks(structured.person, structured.resolve)
    const sourceHeading = normalizeText(root.querySelector('h1')?.textContent ?? '')
    const title = normalizeText(fieldStrings(structured.person?.name, structured.resolve)[0] || sourceHeading || document.title)
    const text = readable.map(block => block.text).join('\n')
    const professional = PROFESSIONAL_TEXT.test(text) || readable.some(block => RESUME_SECTIONS.test(block.text) && block.text.toLowerCase() !== 'about')
    const shortName = /^[\p{L}\p{M}.'’—-]{1,8}$/u.test(sourceHeading) && readable.some(block =>
      /^(?:experience|education|skills|employment|certifications):?$/i.test(block.text))
    const identified = looksLikeName(sourceHeading) || shortName || /\b(?:resume|curriculum vitae|cv|profile|biography|about me)\b/i.test(`${sourceHeading} ${document.title}`) ||
      /\b(?:I am|I'm|I work|I build|I design|I lead|I research|I teach)\b/i.test(text)
    if (structured.unrelated || (!structuredBlocks.length && !(professional && identified))) {
      if (!structured.unrelated && emptyShell) throw new ResumeHtmlShellError()
      throw new ResumeExtractionError('not-a-profile', 'This page does not contain one readable professional profile or resume.')
    }
    // Keep readable paragraphs intact; JSON-LD supplies only evidence not already present.
    const readableText = new Set(readable.map(block => block.text))
    const additional = structuredBlocks.filter(block => !readableText.has(block.text))
    const paragraphs = createParagraphs([...additional, ...readable], PARAGRAPH_OPTIONS)
    const characters = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0)
    const thin = characters < 500 || paragraphs.length < 3
    const warnings = [...new Set(structured.warnings)]
    if (thin) warnings.push('This public profile contains limited resume evidence. Missing details were not inferred.')
    return { title, paragraphs, thin, warnings }
  } catch (error) {
    return parsingError(error)
  } finally {
    dom?.window.close()
  }
}
