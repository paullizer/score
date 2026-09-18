import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import { pdfFixture } from './reference-fixtures.mjs'
import { loadWorker } from './shared-model-loader.mjs'

export const { OPM_CATALOGS } = await loadWorker('../worker/opm/catalogs.ts')
const root = 'https://www.opm.gov'
export const urls = {
  classification340: `${root}/public-fixtures/gs0340.pdf`,
  classification343: `${root}/media/nlipeoym/management-and-program-analysis-series-0343-may-2024.pdf`,
  legacy343: 'http://www.opm.gov/fedclass/gs0343.pdf',
  current343: `${root}/public-fixtures/current-gs0343.pdf`,
  engineering: `${root}/public-fixtures/engineering-family.pdf`,
  contracting: `${root}/public-fixtures/gs1102.pdf`,
  math: `${root}/public-fixtures/math-family.pdf`,
  engineeringIor: `${root}/public-fixtures/professional-engineering-ior.pdf`,
  adminGuide: `${root}/public-fixtures/guides/gsadmn.pdf`,
  researchGuide: `${root}/public-fixtures/guides/gsresch.pdf`,
  supervisorGuide: `${root}/public-fixtures/guides/gssg.pdf`,
  leaderGuide: `${root}/public-fixtures/guides/gslead.pdf`,
  handbook: `${root}/public-fixtures/classifierhandbook.pdf`,
  allQualifications: `${root}/policy-data-oversight/classification-qualifications/general-schedule-qualification-standards/`,
  qualificationPolicy: `${root}/policy-data-oversight/classification-qualifications/general-schedule-qualification-policies/`,
  policyGs: `${OPM_CATALOGS.competency}general-schedule/`,
  policyGroup: `${OPM_CATALOGS.competency}general-schedule/2200/`,
  policySeries: `${OPM_CATALOGS.competency}general-schedule/2200/2210-competency-based-policy/`,
  policyClass: `${OPM_CATALOGS.competency}general-schedule/2200/2210-competency-based-policy/2210-competency-based-classification-standard/`,
  policyPrint: `${OPM_CATALOGS.competency}general-schedule/2200/2210-competency-based-policy/2210-competency-based-classification-standard/print/`,
  policyQual: `${OPM_CATALOGS.competency}general-schedule/2200/2210-competency-based-policy/competency-based-qualification-standard/`,
  issuance: `${root}/chcoc/latest-memos/issued-competency-standard-april-2026.pdf`,
  oldAlternative: `${root}/public-fixtures/alternative-a-2210/`,
}
export const qualificationUrl = series => `${root}/public-fixtures/qualifications/${series}/`
const link = (url, title) => `<a href="${url}">${title}</a>`
export const htmlResponse = html => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) })
export const pdfResponse = bytes => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: bytes })
export const qualificationHtml = (title, content = '', group) => `<main><div id="main-main-content">
  <h1>${title}</h1><h2>Individual Occupational Requirements</h2><p>This public synthetic qualification reference preserves minimum eligibility requirements separately from grading duties and work-level expectations. Alternatives are not cumulative requirements.</p>
  ${content}${group ? `<h2>Associated Group Standard</h2><p>Use ${link(OPM_CATALOGS.groups, `Group Coverage Qualification Standard for ${group}`)} for this series.</p>` : ''}
  </div></main>`

const names = { '0340': 'Program Management Series', '0343': 'Management and Program Analysis Series', '0801': 'General Engineering Series', '0892': 'Ceramic Engineering Series', '1102': 'Contracting Series', '1515': 'Operations Research Series', '0921': 'No Specific Standard Series' }
let prepared
async function assets() {
  if (prepared) return prepared
  prepared = (async () => {
    const map = new Map()
    const standards = `<main><section class="tab-content" title="Overview"><p>A readable overview is not the actual catalog.</p>${link(urls.handbook, "The Classifier's Handbook")}</section>
      <section class="tab-content" title="Standards">
      <table><caption>0300 – General Administrative, Clerical, and Office Services Group</caption>
      <tr><td>0340</td><td>${link(urls.classification340, names['0340'])}</td></tr>
      <tr><td>0343</td><td>${link(urls.classification343, names['0343'])}</td></tr></table>
      <table><caption>0800 – Engineering and Architecture Group</caption><tr><td>0800</td><td>
      ${link(urls.engineering, 'Job Family Standard for Professional Work in the Engineering and Architecture Group')}
      <br>Series Covered:<ul><li>0801, General Engineering</li><li>0803, Safety Engineering</li></ul></td></tr></table>
      <table><caption>1100 – Business and Industry Group</caption><tr><td>1102</td><td>${link(urls.contracting, names['1102'])}</td></tr></table>
      <table><caption>1500 – Mathematical Sciences Group</caption><tr><td>1500</td><td>
      ${link(urls.math, 'Professional Mathematical Sciences Family Standard')}<br>Series Covered:<ul><li>1515, Operations Research</li><li>1520, Mathematics</li></ul></td></tr></table>
      <table><tr><td>0921</td><td>No Specific Standard Series</td></tr></table>
      <table><caption>2200 Group</caption><tr><td>2200</td><td><ul><li>2210, Information Technology Management (see Competency Based Policy for this occupation)</li></ul></td></tr></table>
      </section><section class="tab-content" title="Functional Guides"><table>
      <tr><td>${link(urls.adminGuide, 'Administrative Analysis Grade Evaluation Guide')}</td></tr>
      <tr><td>${link(urls.researchGuide, 'Research Grade Evaluation Guide')}</td></tr>
      <tr><td>${link(urls.supervisorGuide, 'General Schedule Supervisory Guide')}</td></tr>
      <tr><td>${link(urls.leaderGuide, 'General Schedule Leader Grade Evaluation Guide')}</td></tr>
      </table></section></main>`
    const group = (anchor, title) => `<h2><a name="${anchor}"></a>${title}</h2><table>
      <thead><tr><th>Grade</th><th>Education OR experience</th></tr></thead><tbody><tr><th>GS-9</th><td>One stated alternative for ${title}</td></tr>
      <tr><th>GS-11</th><td>Another grade-specific alternative</td></tr></tbody></table><p>A combination may also be accepted; preserve this footnote with the grade rows.</p>`
    const quals = `<main><section class="tab-content" title="Overview"><p>Do not parse this instead of the named series section.</p></section>
      <section class="tab-content" title="Group Standards">
      ${group('GS-CLER', 'Clerical and Administrative Support Positions')}${group('GS-TECH', 'Technical and Medical Support Positions')}
      ${group('GS-ADMIN', 'Administrative and Management Positions')}${group('GS-PROF', 'Professional and Scientific Positions')}
      </section><section class="tab-content" title="Occupational Series"><table>
      <thead><tr><th>Series</th><th>Title</th><th>Exception</th></tr></thead><tbody>
      ${Object.entries(names).map(([series, title]) => `<tr><th scope="row">${series}</th><td>${link(qualificationUrl(series), title)}</td>
      <td>${['0343', '1102'].includes(series) ? link(`${urls.qualificationPolicy}#${series}`, 'GS-5/7') : ''}</td></tr>`).join('')}
      <tr><th scope="row">2210</th><td>${link(urls.oldAlternative, 'Information Technology Management — Alternative A')}</td><td></td></tr>
      </tbody></table></section></main>`
    map.set(OPM_CATALOGS.classification, htmlResponse(standards))
    map.set(OPM_CATALOGS.qualifications, { status: 302, headers: { location: `${urls.allQualifications}#url=List-by-Occupational-Series` }, body: new Uint8Array() })
    map.set(OPM_CATALOGS.groups, { status: 302, headers: { location: `${urls.allQualifications}#GS-CLER` }, body: new Uint8Array() })
    map.set(urls.allQualifications, htmlResponse(quals))
    map.set(OPM_CATALOGS.competency, htmlResponse(`<main><h1>Competency Based Policy</h1>${link(urls.policyGs, 'General Schedule Occupations')}</main>`))
    map.set(urls.policyGs, htmlResponse(`<main>${link(urls.policyGroup, '2200 – Information/Communication Technology and Digital Services Group')}</main>`))
    map.set(urls.policyGroup, htmlResponse(`<main>${link(urls.policySeries, '2210 Information Technology Management Series')}</main>`))
    map.set(urls.policySeries, htmlResponse(`<main><h1>Competency Based Policy for Information Technology</h1>
      ${link(urls.policyClass, 'Classification Standard')}${link(urls.policyQual, 'Qualification Standard')}
      ${link(urls.issuance, 'Issuance memorandum April 2026')}</main>`))
    map.set(urls.policyClass, htmlResponse(`<main><h1>2210 Competency-Based Classification Standard</h1>
      ${link(urls.policyPrint, 'Print Full Classification Standard')}</main><nav>Navigation shell only</nav>`))
    map.set(urls.policyPrint, htmlResponse(`<main><h1>2210 Competency-Based Classification Standard</h1></main>
      <div class="grid-col-12"><h1>Grading Information</h1><p>Issued April 2026. This competency-based classification standard establishes grade-level work expectations for the information technology management series.</p>
      <p>DRAFT placeholder: insert date.</p>${link(urls.issuance, 'Issuance memorandum')}</div>`))
    map.set(urls.policyQual, htmlResponse(`<main><h1>2210 Competency-Based Qualification Standard</h1></main>
      <div class="grid-col-12"><h2>Qualifications by Grade Level</h2><p>Issued April 2026. Apply the competency-based minimum qualification requirements independently from weighted work criteria. Education is one explicitly stated alternative where the standard permits it.</p>
      ${link(urls.issuance, 'Issuance memorandum')}${link(urls.oldAlternative, 'Superseded Alternative A qualification standard')}</div>`))
    for (const [series, title] of Object.entries(names)) {
      const groupTitle = ['0801', '0892', '1515'].includes(series) ? 'Professional and Scientific Positions' : 'Administrative and Management Positions'
      map.set(qualificationUrl(series), htmlResponse(qualificationHtml(title,
        series === '0801' ? `<p>Use the individual occupational requirements for ${link(urls.engineeringIor, 'Professional Engineering Positions')}.</p>`
          : series === '1102' ? '<p>This standard does not apply to Department of Defense positions.</p><p>There is no Group Coverage Qualification Standard for this series.</p>' : '',
        series === '1102' ? undefined : groupTitle)))
    }
    map.set(urls.qualificationPolicy, htmlResponse(`<main>
      <h2 id="0343">0343 qualification policy</h2><p>For GS-5 and GS-7 only, this qualification-index exception concerns allowable education and experience. It does not establish work-level grading for GS-9 or higher.</p>
      <h2 id="1102">1102 qualification policy</h2><p>For GS-5 and GS-7 only, this qualification-index exception concerns allowable education and experience. It does not establish work-level grading for GS-9 or higher.</p>
      </main>`))
    const pdfs = [
      [urls.classification340, 14, [
        { page: 8, url: urls.legacy343, label: 'Management and Program Analysis Series, 0343' },
        { page: 11, url: urls.adminGuide, label: 'Administrative Analysis Grade Evaluation Guide' },
        { page: 4, url: urls.supervisorGuide, label: 'General Schedule Supervisory Guide' },
      ]],
      [urls.classification343, 26, [{ page: 17, url: urls.adminGuide, label: 'Administrative Analysis Grade Evaluation Guide' }]],
      [urls.current343, 20, []],
      [urls.engineering, 177, [
        { page: 9, url: urls.researchGuide, label: 'Research Grade Evaluation Guide' },
        { page: 10, url: urls.supervisorGuide, label: 'General Schedule Supervisory Guide' },
        { page: 11, url: urls.leaderGuide, label: 'General Schedule Leader Grade Evaluation Guide' },
      ]],
      [urls.contracting, 147, []], [urls.math, 8, []], [urls.engineeringIor, 5, []],
      [urls.adminGuide, 40, []], [urls.researchGuide, 30, []], [urls.supervisorGuide, 70, []],
      [urls.leaderGuide, 40, []], [urls.handbook, 45, []], [urls.issuance, 3, []],
    ]
    for (const [url, count, annotations] of pdfs) map.set(url, pdfResponse((await pdfFixture(count, annotations)).bytes))
    const current343 = await PDFDocument.load(map.get(urls.current343).body)
    current343.setTitle('Management and Program Analysis Series, 0343 — October 2024')
    map.set(urls.current343, pdfResponse(await current343.save()))
    map.set(urls.legacy343, { status: 302, headers: { location: urls.current343 }, body: new Uint8Array() })
    return map
  })()
  return prepared
}

export async function fixture() {
  const responses = new Map(await assets())
  const requested = []
  return {
    responses, requested,
    fetcher: async (url, options) => {
      requested.push(url)
      assert.equal(options.followRedirects, false)
      assert.ok(options.maxBytes > 0)
      const response = responses.get(url)
      assert.ok(response, `Discovery must follow only an actual fixture link, not invent a URL: ${url}`)
      return { ...response, url }
    },
  }
}

export const context = (series, changes = {}) => ({
  series, agency: 'Civilian federal agency', agencyType: 'other-federal', supervision: 'nonsupervisory',
  functions: [], specialty: '', confirmed: true, answers: {}, ...changes,
})
