import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { docxFile, legacyDocFile } from '../../server-tests/word-fixtures.mjs'

export const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const docType = 'application/msword'
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=', 'base64')
export const evidenceText = 'Apply engineering methods to defined projects and communicate findings.'
const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const packageNs = 'http://schemas.openxmlformats.org/package/2006/relationships'

export function richPreviewDocx({ images = 1, extraParts = {}, imageBytes = png, imageType = 'image/png' } = {}) {
  const imageName = `one.${{ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' }[imageType]}`
  const picture = (id, name) => `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="${name}" descr="${name}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip ${id === 'remote' ? 'r:link' : 'r:embed'}="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  return docxFile('', {
    documentXml: `<w:document xmlns:w="${wordNs}" xmlns:r="${relNs}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Engineering specialist</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Strong evidence</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>emphasized work</w:t></w:r></w:p>
      <w:p><w:r><w:t>${evidenceText}</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First responsibility</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Skill</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Engineering</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:hyperlink r:id="link"><w:r><w:t>Untrusted hyperlink</w:t></w:r></w:hyperlink></w:p>
      <w:p><w:hyperlink r:id="javascript"><w:r><w:t>Inactive script link</w:t></w:r></w:hyperlink></w:p>
      ${Array.from({ length: images }, () => picture('raster', 'Embedded illustration')).join('')}
      ${picture('remote', 'Linked image')}${picture('vector', 'Active SVG')}
      <w:sectPr/></w:body></w:document>`,
    parts: {
      '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="svg" ContentType="image/svg+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
      'word/_rels/document.xml.rels': `<Relationships xmlns="${packageNs}">
        <Relationship Id="styles" Type="${relNs}/styles" Target="styles.xml"/>
        <Relationship Id="numbering" Type="${relNs}/numbering" Target="numbering.xml"/>
        <Relationship Id="raster" Type="${relNs}/image" Target="media/${imageName}"/>
        <Relationship Id="vector" Type="${relNs}/image" Target="media/active.svg"/>
        <Relationship Id="remote" Type="${relNs}/image" Target="https://external.invalid/private-image.png" TargetMode="External"/>
        <Relationship Id="link" Type="${relNs}/hyperlink" Target="https://external.invalid/private-navigation" TargetMode="External"/>
        <Relationship Id="javascript" Type="${relNs}/hyperlink" Target="javascript:parent.__previewXss=true" TargetMode="External"/>
      </Relationships>`,
      'word/numbering.xml': `<w:numbering xmlns:w="${wordNs}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
      [`word/media/${imageName}`]: imageBytes,
      'word/media/active.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="parent.__previewXss=true"><script>fetch("https://external.invalid/svg")</script></svg>',
      'mammoth/style-map': "p[style-name='Heading 1'] => script:fresh",
      ...extraParts,
    },
  })
}

// esbuild does not transform Vite's worker URL convention in custom browser fixtures.
export function docxPreviewBrowserPlugin() {
  return {
    name: 'private-docx-test-worker',
    setup(builder) {
      builder.onLoad({ filter: /docxPreviewClient\.ts$/ }, async ({ path }) => ({
        contents: (await readFile(path, 'utf8')).replace("new URL('./docxPreview.worker.ts', import.meta.url)", "new URL('./docxPreview.worker.js', import.meta.url)"),
        loader: 'ts',
      }))
    },
  }
}

export async function buildDocxPreviewTestWorker(directory) {
  await build({
    entryPoints: [join('src', 'components', 'documents', 'docxPreview.worker.ts')], outfile: join(directory, 'docxPreview.worker.js'),
    bundle: true, platform: 'browser', format: 'esm', logLevel: 'silent',
  })
}

const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WorkspaceContext } from './src/app/workspace-context';
import { RealResumesContext, useRealResumes } from './src/app/real-resumes-context';
import { RealResumesBridge } from './src/app/RealResumesBridge';
import { JobDetail, JobsPage } from './src/features/jobs/JobsPage';
import { JobImport } from './src/features/jobs/JobImport';
import { RealResumesPage } from './src/features/resumes/RealResumesPage';
import { RealAddResumesDialog } from './src/features/resumes/RealAddResumesDialog';
import { sanitizeDocxPreview } from './src/components/documents/docxPreviewSanitize';
import { fetchPrivateDocx } from './src/components/documents/docxPreviewClient';
import { validatePreviewArchive } from './src/components/documents/docxPreviewSafety';
import { importRealJobFile, importRealJobPdf, importRealJobUrl } from './src/services/realJobs';
import { JOB_IMPORT_LIMITS } from './src/domain/real-jobs';
import { RESUME_IMPORT_LIMITS } from './src/domain/real-resumes';
const root = createRoot(document.getElementById('root'));
let config = await (await fetch('/test-state')).json();
const noop = () => {};
const done = async () => {};
function ResumeProbe() {
  const api = useRealResumes();
  window.wordTest.resumeItems = () => api.batches.flatMap(batch => batch.items.map(item => ({kind:item.source.kind, state:item.state, hasFile:!!item.source.file, key:item.key})));
  return null;
}
function tree() {
  const {workspaceId, format, original, mode, text} = config;
  const stamp = '2026-09-18T10:00:00.000Z';
  const id = config.id ?? 'one';
  const documentId = 'document-' + id;
  const jobId = 'job-' + id;
  const fileName = 'engineering.' + format;
  const paragraph = {id:'engineering-work',page:1,heading:'Engineering work',text};
  const sourceDocument = {id:documentId,version:1,kind:'job',title:config.title??'Engineering specialist',sample:false,paragraphs:[paragraph]};
  const citation = {documentId,documentVersion:1,paragraphId:paragraph.id,page:1,heading:paragraph.heading,quote:text};
  const rubric = {id:'rubric-one',groupId:'group-one',kind:'job',jobId,name:'Engineering rubric',description:'Grounded in the private source',version:1,dataKind:'real',createdAt:stamp,
    provenance:{kind:'generated',model:'test',promptVersion:'test'}, criteria:[{id:'engineering-criterion',key:'custom',label:'Engineering methods',description:text,weight:100,guidance:'Review exact evidence.',requirementType:'required',sourceParagraphId:paragraph.id,sourceCitations:[citation]}]};
  const job = {id:jobId,title:sourceDocument.title,organization:'Synthetic agency',location:'Remote',arrangement:'Remote',employmentType:'Full time',grade:'GS-9',series:'0801',
    source:format,sourceLabel:fileName,documentId,rubricId:rubric.id,status:'ready',createdAt:stamp,dataKind:'real'};
  const source = {kind:format,displayName:fileName,originalContentType:original.contentType,bytes:original.bytes,sha256:original.sha256,capturedAt:stamp};
  const summary = {job,source,rubric,etag:'"one"',updatedAt:stamp,attempts:1,warnings:[]};
  const detail = {...summary,document:sourceDocument,rubricVersions:[rubric]};
  const features = {realJobImports:true,realResumeImports:true,wordDocumentImports:config.wordEnabled,limits:JOB_IMPORT_LIMITS,resumeLimits:RESUME_IMPORT_LIMITS};
  const originalUrl = (kind, recordId) => '/api/workspaces/'+encodeURIComponent(workspaceId)+'/'+kind+'/'+encodeURIComponent(recordId)+'/original';
  const realJobs = {phase:'ready',features,summaries:mode==='job-import'?[]:[summary],error:null,detail:()=>({state:'ready',value:detail}),source:()=>source,ensureDetail:done,refresh:done,
    importFile:(file,key,batch)=>importRealJobFile(workspaceId,file,key,batch),importPdf:(file,key,batch)=>importRealJobPdf(workspaceId,file,key,batch),importUrl:(url,key,batch)=>importRealJobUrl(workspaceId,url,key,batch),
    originalUrl:id=>originalUrl('jobs',id)};
  const cloud = {currentWorkspaceId:workspaceId,workspaces:[{id:workspaceId,role:'owner'}],realJobs};
  const value = {workspace:{schemaVersion:1,jobs:[job],resumes:[],rubrics:[rubric],documents:[sourceDocument],runs:[]},notice:null,storageError:null,notify:noop,clearNotice:noop,
    addJobs:()=>[],addResumes:async()=>[],cancelJob:done,retryJob:done,saveRubric:async()=>rubric.id,startAnalysis:()=>{throw Error('Scoring must remain manual')},cancelRun:noop,retryRun:noop,resetDemo:noop,retrySave:noop,
    ...(mode==='sample-import'?{}:{cloud})};
  const resumeId = 'resume-'+id;
  const resumeDocument = {...sourceDocument,kind:'resume'};
  const docRef = {blobName:'private/document.json',contentType:'application/json',sha256:'a'.repeat(64),bytes:300,documentId,documentVersion:1};
  const resumeDetail = {workspaceId,resume:{id:resumeId,dataKind:'real',name:'Synthetic candidate',role:'Engineering specialist',location:null,experience:null,documentId,documentVersion:1,sourceLabel:fileName,batchId:'batch-one',status:'ready',createdAt:stamp},
    source:{kind:format,displayName:fileName,fileName},capture:{original:{blobName:'private/original.'+format,...original},capturedAt:stamp,redirects:[]},documentRef:docRef,document:resumeDocument,profile:null,
    extraction:{method:format==='doc'?'legacy-word':'document-intelligence',version:'test',extractedAt:stamp,pagination:'captured-sections',pageCount:null,normalizedCharacters:text.length,document:docRef},
    etag:'"resume-one"',updatedAt:stamp,attempts:1,retryCount:0,warnings:[],duplicates:[]};
  const resumes = {workspaceId,canWrite:true,phase:'ready',features,error:null,summaries:[resumeDetail],detail:()=>({state:'ready',value:resumeDetail}),ensureDetail:done,refresh:done,pending:()=>false,originalUrl:id=>originalUrl('resumes',id)};
  const content = mode==='resume'
    ? <RealResumesContext.Provider value={resumes}><RealResumesPage id={resumeId}/></RealResumesContext.Provider>
    : mode==='resume-import'
    ? <RealResumesBridge workspaceId={workspaceId}><ResumeProbe/><RealAddResumesDialog open onOpenChange={noop}/></RealResumesBridge>
    : mode==='job-import'||mode==='sample-import' ? <JobImport onClose={noop}/> : mode==='jobs' ? <JobsPage/>
    : <Routes><Route path="/jobs/:id" element={<JobDetail/>}/></Routes>;
  return <MemoryRouter key={workspaceId+':'+id+':'+mode+':'+format} initialEntries={['/jobs/'+jobId]} future={{v7_startTransition:true,v7_relativeSplatPath:true}}>
    <WorkspaceContext.Provider value={value}>{content}</WorkspaceContext.Provider></MemoryRouter>;
}
window.wordTest = {
  render(overrides){config={...config,...overrides};root.render(tree());},
  sanitize:sanitizeDocxPreview,
  fetchOriginal:async(url,metadata)=>Array.from(new Uint8Array(await fetchPrivateDocx(url,metadata,new AbortController().signal))),
  validateArchive:async(bytes)=>validatePreviewArchive(new Uint8Array(bytes).buffer),
};
root.render(tree());
`

export async function buildWordPreviewTestRuntime() {
  const directory = resolve(`.word-preview-browser-${randomUUID()}`)
  await mkdir(directory)
  try {
    await Promise.all([
      build({
        stdin: { contents: harness, resolveDir: process.cwd(), sourcefile: 'word-preview-harness.tsx', loader: 'tsx' },
        outfile: join(directory, 'browser.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic',
        plugins: [docxPreviewBrowserPlugin()], define: { 'import.meta.env.VITE_DEPLOYMENT_MODE': '"cloud"', 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
      }),
      buildDocxPreviewTestWorker(directory),
    ])
    const [{ default: postcss }, { default: tailwind }, { default: autoprefixer }] = await Promise.all([import('postcss'), import('tailwindcss'), import('autoprefixer')])
    const css = await postcss([tailwind(), autoprefixer()]).process(await readFile(join('src', 'styles', 'globals.css'), 'utf8'), { from: join('src', 'styles', 'globals.css') })
    await writeFile(join(directory, 'browser.css'), css.css)
    await writeFile(join(directory, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Private Word browser tests</title><link rel="stylesheet" href="/browser.css"></head><body><div id="root"></div><script type="module" src="/browser.js"></script></body></html>')
    return { directory, close: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}

export async function startWordPreviewFixture(runtime, options = {}) {
  const format = options.format ?? 'docx'
  const bytes = options.bytes ?? (format === 'doc' ? legacyDocFile(evidenceText) : richPreviewDocx())
  const contentType = format === 'doc' ? docType : docxType
  const original = { contentType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...options.metadata }
  const state = { mode: 'job', workspaceId: 'workspace-one', format, original, wordEnabled: true, text: evidenceText, ...options.state }
  const requests = []
  const controls = { original: null, upload: null }
  let port
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname
      const request = { url: req.url, method: req.method, headers: { ...req.headers } }
      requests.push(request)
      const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
      if (path === '/test-state') { json(state); return }
      if (path === '/api/features') { json({ realJobImports: true, realResumeImports: true, wordDocumentImports: state.wordEnabled }); return }
      if (/\/original$/.test(path)) {
        if (!req.headers.cookie?.includes('private-session=authorized')) { json({ error: 'Unauthorized' }, 401); return }
        if (controls.original && await controls.original(req, res, request)) return
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="original.${format}"`, 'Cache-Control': 'private, no-store' })
        res.end(bytes)
        return
      }
      if (/\/(?:resumes|jobs)\/(?:file|pdf|url)$/.test(path) && req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        request.bytes = Buffer.concat(chunks)
        if (controls.upload && await controls.upload(req, res, request)) return
        const name = decodeURIComponent(req.headers['x-file-name'] ?? '')
        const type = name.split('.').at(-1).toLowerCase()
        const id = `${path.includes('/resumes/') ? 'resume' : 'job'}-${requests.filter((entry) => entry.method === 'POST').length}`
        const stamp = '2026-09-18T10:00:00.000Z'
        const source = path.endsWith('/url') ? { kind: 'url', displayName: 'Public profile', url: JSON.parse(request.bytes).url } : { kind: type, displayName: name, fileName: name }
        if (id.startsWith('resume')) json({ resume: {
          resume: { id, dataKind: 'real', name: null, role: null, location: null, experience: null, documentId: `document-${id}`, documentVersion: 1,
            sourceLabel: source.displayName, batchId: req.headers['x-import-batch'], status: 'queued', createdAt: stamp },
          workspaceId: state.workspaceId, source, capture: null, documentRef: null, etag: `"${id}"`, updatedAt: stamp, attempts: 0, retryCount: 0, warnings: [], duplicates: [],
        } }, 202)
        else json({ job: { job: { id, dataKind: 'real', status: 'queued' }, source, rubric: null, etag: `"${id}"`, updatedAt: stamp, attempts: 0, warnings: [] } }, 202)
        return
      }
      if (/\/resumes$/.test(path)) { json({ resumes: [] }); return }
      const name = ['browser.js', 'docxPreview.worker.js', 'browser.css'].find((item) => path === `/${item}`) ?? 'index.html'
      res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' })
      res.end(await readFile(join(runtime.directory, name)))
    } catch (error) { if (!res.headersSent) res.statusCode = 500; if (!res.destroyed) res.end(String(error)) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  port = server.address().port
  return { origin: `http://127.0.0.1:${port}`, state, requests, controls, bytes, original, async close() {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  } }
}
