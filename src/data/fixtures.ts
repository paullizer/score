import type { CriterionKey, Job, Resume, Rubric, SourceDocument, SourceKind, Workspace } from '../domain/types'
import { evaluateComparison, snapshotAnalysisRun } from '../services/scoring'

type EvidenceKey = Exclude<CriterionKey, 'custom'>

interface Requirement {
  key: EvidenceKey
  label: string
  weight: number
  text: string
}

interface JobDefinition {
  title: string
  organization: string
  location: string
  arrangement: string
  grade: string
  series: string
  source: SourceKind
  sourceLabel: string
  overview: string
  requirements: Requirement[]
}

const CREATED_AT = '2026-09-10T09:00:00.000Z'
const SYNTHETIC_NOTICE = 'This document is entirely synthetic and was written for the Score UI demonstration. All people, organizations, employment histories, projects, and outcomes described here are fictional. No selected file contents were read, and no website was fetched.'

function seedId(value: number): string {
  return `9e870c40-54f2-4b16-8d47-${value.toString(16).padStart(12, '0')}`
}

function guidance(key: EvidenceKey): string {
  const focus: Record<EvidenceKey, string> = {
    technical: 'implementation, operational reliability, and technical depth',
    delivery: 'planning, ownership, risk management, and delivery outcomes',
    analysis: 'sound methods, interpretation, and evidence-informed decisions',
    communication: 'clear writing, audience awareness, and engagement',
    leadership: 'team coordination, coaching, and accountable decisions',
    policy: 'policy interpretation, stewardship, and documented controls',
  }
  return `Illustrative 0–5 anchors for ${focus[key]}: 0 = no cited support; 1 = introductory exposure; 2 = limited contribution; 3 = independent examples with gaps; 4 = substantial relevant examples; 5 = sustained ownership with clear outcomes. Scores use fixed synthetic evidence mappings, not automated judgments.`
}

const jobDefinitions: JobDefinition[] = [
  {
    title: 'Program Management Analyst (Synthetic)',
    organization: 'Civic Programs Bureau · fictional',
    location: 'Washington, DC',
    arrangement: 'Hybrid',
    grade: 'GS-12',
    series: '0343',
    source: 'pdf',
    sourceLabel: 'Synthetic civic program analyst.pdf',
    overview: 'The fictional Civic Programs Bureau is piloting a shared public-service grants platform. This demonstration role coordinates a cross-office delivery portfolio, translates operational data into decisions, and keeps sponsors informed about milestones and risks.',
    requirements: [
      { key: 'delivery', label: 'Program planning and delivery', weight: 30, text: 'Develop an integrated delivery plan for several workstreams. Track milestones, dependencies, spending, and risks; explain corrective actions when a public-service project moves off plan.' },
      { key: 'analysis', label: 'Operational analysis', weight: 25, text: 'Compare service measures across offices, investigate inconsistent reporting, and turn findings into practical options. Document assumptions and limitations rather than presenting a dashboard as the whole explanation.' },
      { key: 'communication', label: 'Executive communication', weight: 20, text: 'Write concise decision briefs and facilitate working sessions with program, finance, and technology partners. Adapt the level of detail for sponsors and delivery teams.' },
      { key: 'leadership', label: 'Cross-functional leadership', weight: 15, text: 'Coordinate contributors who report to different managers. Clarify ownership, resolve delivery tradeoffs, and coach colleagues on dependable planning practices.' },
      { key: 'policy', label: 'Public-sector stewardship', weight: 10, text: 'Maintain decision records, follow the program office’s illustrative review controls, and identify when a policy question requires specialist advice.' },
    ],
  },
  {
    title: 'Cloud Platform Engineer (Synthetic)',
    organization: 'Public Digital Services Lab · fictional',
    location: 'Denver, CO',
    arrangement: 'Remote eligible',
    grade: 'GS-13',
    series: '2210',
    source: 'url',
    sourceLabel: 'https://public-service.example/jobs/cloud-platform-engineer',
    overview: 'The fictional Public Digital Services Lab operates shared hosting for community-service applications. This demonstration engineering role makes cloud environments repeatable, improves incident response, and helps product teams deliver reliable services.',
    requirements: [
      { key: 'technical', label: 'Cloud operations and automation', weight: 40, text: 'Build repeatable cloud environments using infrastructure as code, deployment automation, and observable services. Show practical experience diagnosing reliability problems and improving recovery procedures.' },
      { key: 'delivery', label: 'Reliable service delivery', weight: 20, text: 'Plan incremental platform releases with rollback options, service objectives, and tracked dependencies. Balance project delivery with operational support.' },
      { key: 'analysis', label: 'Reliability investigation', weight: 20, text: 'Use logs, service measurements, and incident timelines to test hypotheses about failures. Explain root causes, uncertainty, and the expected effect of a proposed change.' },
      { key: 'communication', label: 'Technical documentation', weight: 10, text: 'Write runbooks and architecture notes that application teams can use without the original author present. Explain technical risks in accessible language.' },
      { key: 'leadership', label: 'Engineering collaboration', weight: 10, text: 'Review technical proposals, mentor colleagues, and coordinate changes across application and operations teams without losing clear accountability.' },
    ],
  },
  {
    title: 'Policy and Grants Specialist (Synthetic)',
    organization: 'Community Investment Office · fictional',
    location: 'Chicago, IL',
    arrangement: 'Hybrid',
    grade: 'GS-11',
    series: '1109',
    source: 'website',
    sourceLabel: 'https://public-service.example/careers/policy-grants-specialist',
    overview: 'The fictional Community Investment Office supports small local-service grants. This sample position interprets program guidance, reviews consistent application of award controls, and explains requirements to partner organizations.',
    requirements: [
      { key: 'policy', label: 'Grants policy interpretation', weight: 35, text: 'Interpret program rules and explain how they apply to grant review, award documentation, and monitoring. Escalate ambiguous issues rather than creating unsupported policy decisions.' },
      { key: 'analysis', label: 'Review and compliance analysis', weight: 25, text: 'Examine award records, reconcile conflicting information, and identify patterns requiring follow-up. Record the basis for a finding so another reviewer can reproduce it.' },
      { key: 'communication', label: 'Partner guidance', weight: 20, text: 'Translate detailed guidance into plain-language materials and respond consistently to partner questions. Keep examples distinct from binding requirements.' },
      { key: 'delivery', label: 'Award-cycle coordination', weight: 10, text: 'Maintain a review schedule, track outstanding documentation, and coordinate handoffs between policy, finance, and program teams.' },
      { key: 'leadership', label: 'Peer review and coaching', weight: 10, text: 'Help reviewers calibrate their work, share reusable checklists, and surface disagreements constructively during case discussions.' },
    ],
  },
  {
    title: 'Public Health Data Analyst (Synthetic)',
    organization: 'Regional Health Data Service · fictional',
    location: 'Atlanta, GA',
    arrangement: 'Remote eligible',
    grade: 'GS-12',
    series: '0601',
    source: 'pdf',
    sourceLabel: 'Synthetic public health data analyst.pdf',
    overview: 'The fictional Regional Health Data Service publishes demonstration measures for service planning. This sample role joins operational data, checks quality, and communicates population-level trends without handling actual patient records.',
    requirements: [
      { key: 'analysis', label: 'Statistical and data-quality analysis', weight: 35, text: 'Design reproducible analyses of service trends, test data quality, and explain uncertainty. Distinguish an observed association from a causal claim.' },
      { key: 'technical', label: 'Reproducible data workflows', weight: 25, text: 'Use SQL and a scripting language to build documented transformations, validation checks, and repeatable reports. Keep data definitions and versioned methods alongside outputs.' },
      { key: 'communication', label: 'Accessible analytical reporting', weight: 20, text: 'Explain measures, caveats, and practical implications to program staff who are not statisticians. Create clear narrative summaries and accessible charts.' },
      { key: 'policy', label: 'Data stewardship', weight: 10, text: 'Apply the office’s illustrative access, retention, and disclosure controls. Record the purpose and limitations of a dataset before sharing an analysis.' },
      { key: 'delivery', label: 'Reporting-cycle ownership', weight: 10, text: 'Coordinate recurring releases, track quality issues to resolution, and communicate changes to users before a reporting deadline.' },
    ],
  },
  {
    title: 'Cybersecurity Program Lead (Synthetic)',
    organization: 'Civic Infrastructure Agency · fictional',
    location: 'Arlington, VA',
    arrangement: 'Hybrid',
    grade: 'GS-13',
    series: '2210',
    source: 'url',
    sourceLabel: 'https://public-service.example/jobs/cybersecurity-program-lead',
    overview: 'The fictional Civic Infrastructure Agency is improving security practices across a demonstration service portfolio. This sample lead coordinates technical remediation, risk records, and security delivery; it is not a real vacancy or clearance requirement.',
    requirements: [
      { key: 'technical', label: 'Security engineering foundations', weight: 30, text: 'Understand identity controls, secure configuration, vulnerability remediation, and incident response. Translate a technical finding into a practical improvement with verifiable completion criteria.' },
      { key: 'leadership', label: 'Security program leadership', weight: 20, text: 'Set priorities for a mixed engineering and assurance team, coach workstream owners, and make documented tradeoffs when capacity is constrained.' },
      { key: 'policy', label: 'Risk and control stewardship', weight: 20, text: 'Maintain a traceable risk register, map evidence to the program’s illustrative controls, and document decisions with the appropriate accountable owner.' },
      { key: 'delivery', label: 'Remediation delivery', weight: 15, text: 'Sequence remediation work by risk and dependency, track overdue actions, and verify that completed tasks improve the service rather than merely close a ticket.' },
      { key: 'analysis', label: 'Risk-based analysis', weight: 10, text: 'Compare incident and vulnerability trends, identify systemic causes, and explain the evidence behind a recommended priority.' },
      { key: 'communication', label: 'Security stakeholder briefings', weight: 5, text: 'Explain a security issue, its service impact, and the available choices to both engineers and nontechnical program sponsors.' },
    ],
  },
  {
    title: 'Community Engagement Coordinator (Synthetic)',
    organization: 'Office of Public Participation · fictional',
    location: 'Baltimore, MD',
    arrangement: 'Office and community sites',
    grade: 'GS-9',
    series: '0301',
    source: 'website',
    sourceLabel: 'https://public-service.example/careers/community-engagement-coordinator',
    overview: 'The fictional Office of Public Participation coordinates feedback on local-service pilots. This demonstration position organizes listening sessions, prepares clear materials, and ensures that community questions receive a documented response.',
    requirements: [
      { key: 'communication', label: 'Community communication', weight: 40, text: 'Prepare plain-language outreach materials, facilitate respectful listening sessions, and adapt communication to the needs of different audiences.' },
      { key: 'delivery', label: 'Engagement logistics', weight: 25, text: 'Coordinate venues, accessible meeting materials, partner schedules, and follow-up actions. Keep a dependable plan for several events at once.' },
      { key: 'analysis', label: 'Feedback synthesis', weight: 20, text: 'Organize comments into transparent themes, separate frequency from importance, and explain what the available feedback can and cannot establish.' },
      { key: 'policy', label: 'Public participation records', weight: 15, text: 'Follow the demonstration office’s records and participation guidance. Keep consent, meeting notes, and response commitments organized for review.' },
    ],
  },
]

interface ResumeEvidence {
  key: EvidenceKey
  score: number
  heading: string
  text: string
}

interface ResumeDefinition {
  name: string
  role: string
  location: string
  experience: string
  profile: string
  evidence: ResumeEvidence[]
}

const resumeDefinitions: ResumeDefinition[] = [
  {
    name: 'Avery Chen',
    role: 'Program Delivery Lead',
    location: 'Washington, DC',
    experience: '9 years · fictional history',
    profile: 'Avery Chen is a fictional program delivery professional at the invented Harbor Civic Services Cooperative. This sample history emphasizes cross-office planning, operational analysis, and clear decision records rather than deep engineering.',
    evidence: [
      { key: 'delivery', score: 5, heading: 'Multi-office program delivery', text: 'Owned a fictional six-workstream service modernization plan across four offices. Introduced a dependency register and weekly risk reviews; the sample team completed 18 of 20 planned milestones within the agreed quarter and documented recovery plans for the remaining two.' },
      { key: 'analysis', score: 4, heading: 'Operational decision support', text: 'Reconciled inconsistent intake measures across four office reports and built a documented comparison of wait times. Presented three staffing options with explicit assumptions, helping the fictional sponsors choose a limited pilot rather than an unsupported organization-wide change.' },
      { key: 'communication', score: 4, heading: 'Decision briefs and working sessions', text: 'Wrote two-page sponsor briefs that separated decisions, evidence, risks, and next steps. Facilitated monthly sessions with program, finance, and technology partners and maintained a shared record of decisions and owners.' },
      { key: 'leadership', score: 4, heading: 'Cross-functional coordination', text: 'Coordinated nine contributors across three reporting lines. Coached two new workstream leads on milestone planning and negotiated a shared release sequence when two projects needed the same specialist.' },
      { key: 'policy', score: 3, heading: 'Program review controls', text: 'Maintained a review checklist and decision log for a fictional grant-service pilot. Checked that required approvals were recorded and referred ambiguous award-policy questions to a specialist rather than interpreting them independently.' },
      { key: 'technical', score: 1, heading: 'Introductory reporting tools', text: 'Maintained spreadsheet trackers and updated an existing low-code status dashboard using a documented procedure. Engineering colleagues owned the underlying integrations, deployment configuration, and service reliability.' },
    ],
  },
  {
    name: 'Jordan Ellis',
    role: 'Cloud Platform Engineer',
    location: 'Denver, CO',
    experience: '8 years · fictional history',
    profile: 'Jordan Ellis is a fictional engineer at the invented Juniper Public Technology Studio. The sample work centers on dependable cloud platforms, repeatable deployments, and incident learning; the document does not include a grants-policy example.',
    evidence: [
      { key: 'technical', score: 5, heading: 'Cloud foundations and automation', text: 'Built version-controlled infrastructure templates and deployment pipelines for twelve fictional service environments. Added configuration checks, rollback steps, and telemetry; a rehearsed recovery exercise restored the sample service in 24 minutes against a 45-minute target.' },
      { key: 'delivery', score: 4, heading: 'Incremental platform releases', text: 'Delivered a shared platform migration in four increments while maintaining the support rota. Published dependency and rollback plans for each release and met the agreed change windows for eleven of twelve demonstration applications.' },
      { key: 'analysis', score: 4, heading: 'Incident investigation', text: 'Used request traces, deployment records, and an incident timeline to isolate connection-pool exhaustion in a fictional application. Tested the proposed limit change under load and documented both the measured improvement and the remaining capacity uncertainty.' },
      { key: 'communication', score: 3, heading: 'Runbooks and technical notes', text: 'Wrote recovery runbooks and short architecture notes for the platform team. Colleagues successfully followed the runbooks during a rehearsal; nontechnical sponsor communications were generally prepared by the delivery lead.' },
      { key: 'leadership', score: 3, heading: 'Engineering peer support', text: 'Reviewed infrastructure changes and paired with two engineers on their first platform releases. Coordinated technical handoffs with application teams, while the engineering manager retained staffing and portfolio-priority decisions.' },
    ],
  },
  {
    name: 'Morgan Patel',
    role: 'Grants Policy Advisor',
    location: 'Chicago, IL',
    experience: '10 years · fictional history',
    profile: 'Morgan Patel is a fictional policy professional at the invented Common Ground Programs Institute. This illustrative history covers grant controls, reproducible case reviews, and partner guidance, without claiming platform-engineering experience.',
    evidence: [
      { key: 'policy', score: 5, heading: 'Grants guidance and stewardship', text: 'Led the rewrite of a fictional small-grants review handbook and traced each checklist item to the program’s approved guidance. Documented interpretations with policy owners and introduced a clear escalation path for exceptions instead of allowing informal precedents.' },
      { key: 'analysis', score: 4, heading: 'Reproducible case review', text: 'Reviewed eighty fictional award files, reconciled inconsistent monitoring records, and categorized recurring documentation gaps. Kept a record-level audit trail so a second reviewer could reproduce each finding and distinguish missing records from confirmed noncompliance.' },
      { key: 'communication', score: 4, heading: 'Plain-language partner guidance', text: 'Created plain-language application examples and facilitated six fictional partner workshops. Maintained a question log that separated illustrative advice from binding program requirements and routed unresolved policy questions to the accountable owner.' },
      { key: 'delivery', score: 3, heading: 'Award-cycle coordination', text: 'Maintained a shared calendar for two fictional award cycles and tracked outstanding review documents. Coordinated handoffs with finance staff, while a program manager owned the overall budget and delivery risks.' },
      { key: 'leadership', score: 3, heading: 'Reviewer calibration', text: 'Facilitated monthly case discussions for five reviewers and shared a reusable evidence checklist. Helped peers identify inconsistent interpretations; formal performance management and resource allocation remained with the team supervisor.' },
    ],
  },
  {
    name: 'Riley Brooks',
    role: 'Public Health Analytics Specialist',
    location: 'Atlanta, GA',
    experience: '6 years · fictional history',
    profile: 'Riley Brooks is a fictional analyst at the invented Open Harbor Health Collaborative. All measures in this resume describe fabricated service data, not actual patient records. The sample emphasizes reproducible analysis rather than team management.',
    evidence: [
      { key: 'analysis', score: 5, heading: 'Reproducible service-trend analysis', text: 'Designed a fictional service-access study with documented measures, sensitivity checks, and uncertainty intervals. Identified a reporting-definition change behind an apparent trend and clearly separated that artifact from genuine variation before presenting planning options.' },
      { key: 'technical', score: 4, heading: 'SQL and Python data workflows', text: 'Built version-controlled SQL transformations and Python validation checks for a synthetic monthly reporting pipeline. Added tests for duplicate records, missing values, and denominator changes, with data definitions stored alongside the analysis code.' },
      { key: 'communication', score: 3, heading: 'Analytical reporting', text: 'Prepared annotated charts and short measure notes for fictional service planners. Explained uncertainty and limitations during monthly reporting meetings; broader community consultation materials were produced with a communications specialist.' },
      { key: 'policy', score: 3, heading: 'Data stewardship practices', text: 'Maintained a purpose statement, access checklist, and retention record for the demonstration datasets. Followed approved disclosure procedures and sought a specialist review when a proposed breakdown could be misleading.' },
      { key: 'delivery', score: 3, heading: 'Recurring report releases', text: 'Owned the release checklist for twelve synthetic monthly reports and tracked validation issues to resolution. Coordinated revised data definitions with users before publication, while a project lead handled larger cross-team dependencies.' },
    ],
  },
  {
    name: 'Casey Rivera',
    role: 'Security Delivery Lead',
    location: 'Arlington, VA',
    experience: '12 years · fictional history',
    profile: 'Casey Rivera is a fictional security delivery professional at the invented Beacon Civic Infrastructure Group. The sample history combines technical remediation, risk stewardship, and team leadership; no real security incident or credential is described.',
    evidence: [
      { key: 'technical', score: 4, heading: 'Security engineering improvements', text: 'Coordinated identity-control improvements, secure configuration checks, and vulnerability remediation across eight fictional services. Worked with engineers to define verifiable completion criteria and rehearsed containment and recovery steps in a tabletop exercise.' },
      { key: 'leadership', score: 5, heading: 'Security program leadership', text: 'Led a fictional team of seven engineering and assurance contributors through a year-long improvement program. Coached three workstream owners, set explicit decision rights, and documented capacity tradeoffs with sponsors when new high-priority work arrived.' },
      { key: 'delivery', score: 4, heading: 'Risk-prioritized remediation', text: 'Sequenced forty fictional remediation actions by service impact and dependency. Established evidence-based closure reviews, reduced the sample overdue backlog from fourteen items to four, and retained owner-approved plans for the unresolved actions.' },
      { key: 'policy', score: 4, heading: 'Control evidence and risk records', text: 'Maintained a traceable risk register and mapped review evidence to the fictional organization’s control framework. Recorded acceptance decisions with accountable owners and kept technical advice distinct from formal authorization decisions.' },
      { key: 'analysis', score: 4, heading: 'Security trend analysis', text: 'Compared synthetic incident and vulnerability trends and found that repeated configuration drift explained several recurring findings. Tested the hypothesis against change records and recommended a configuration check with a documented measure of success.' },
      { key: 'communication', score: 3, heading: 'Risk briefings', text: 'Presented monthly risk summaries with service impacts and clear choices for fictional program sponsors. Technical teams used the accompanying detail, while a communications partner helped adapt materials for a wider public audience.' },
    ],
  },
  {
    name: 'Taylor Okafor',
    role: 'Community Partnerships Coordinator',
    location: 'Baltimore, MD',
    experience: '4 years · fictional history',
    profile: 'Taylor Okafor is a fictional coordinator at the invented Neighborhood Service Exchange. This demonstration resume emphasizes accessible community communication and dependable event follow-up, with only introductory policy and analysis responsibilities.',
    evidence: [
      { key: 'communication', score: 5, heading: 'Community listening and outreach', text: 'Designed plain-language outreach materials and facilitated fourteen fictional community listening sessions. Worked with accessibility partners on meeting formats, maintained a transparent question-and-response log, and shared a readable account of what changed after the feedback.' },
      { key: 'delivery', score: 3, heading: 'Engagement event coordination', text: 'Coordinated venues, partner schedules, accessible materials, and follow-up tasks for a fictional three-neighborhood service pilot. Kept a shared event checklist and escalated budget changes to the program lead.' },
      { key: 'analysis', score: 2, heading: 'Introductory feedback synthesis', text: 'Tagged comments using an existing theme guide and counted recurring questions in a spreadsheet. A senior analyst reviewed the categories and explained sampling limitations before the findings were used in planning.' },
      { key: 'leadership', score: 2, heading: 'Volunteer coordination', text: 'Assigned event-day tasks to four fictional volunteers and checked that follow-up owners were clear. The partnership manager handled coaching plans, staffing decisions, and competing commitments across programs.' },
      { key: 'policy', score: 2, heading: 'Participation records', text: 'Used an approved checklist to organize meeting notes, participation permissions, and response commitments. Referred unusual records questions to the office coordinator rather than independently interpreting policy.' },
    ],
  },
]

interface GradeDefinition {
  ladder: string
  grade: string
  scope: string
  criteria: Requirement[]
}

const gradeDefinitions: GradeDefinition[] = [
  {
    ladder: 'Program management', grade: 'GS-9', scope: 'bounded assignments with established methods and review',
    criteria: [
      { key: 'delivery', label: 'Assignment planning', weight: 30, text: 'Illustrative scope: maintain a bounded work plan, identify dependencies, and keep commitments visible to a reviewing lead.' },
      { key: 'analysis', label: 'Structured operational analysis', weight: 25, text: 'Illustrative scope: apply a documented method, check the inputs, and describe the limitations of a straightforward comparison.' },
      { key: 'communication', label: 'Clear working communication', weight: 25, text: 'Illustrative scope: prepare understandable notes, status updates, and audience-appropriate working materials.' },
      { key: 'policy', label: 'Following established guidance', weight: 20, text: 'Illustrative scope: apply an established checklist and recognize when a question needs specialist review.' },
    ],
  },
  {
    ladder: 'Program management', grade: 'GS-11', scope: 'independent workstreams and coordination across partners',
    criteria: [
      { key: 'delivery', label: 'Workstream ownership', weight: 30, text: 'Illustrative scope: own a workstream plan, manage emerging risks, and coordinate handoffs with partner teams.' },
      { key: 'analysis', label: 'Independent options analysis', weight: 25, text: 'Illustrative scope: compare plausible options, explain assumptions, and support a recommendation with traceable evidence.' },
      { key: 'communication', label: 'Partner decision support', weight: 20, text: 'Illustrative scope: tailor briefs and facilitate working discussions that leave clear decisions and owners.' },
      { key: 'leadership', label: 'Peer coordination', weight: 15, text: 'Illustrative scope: coordinate contributors and improve shared methods without relying on formal supervisory authority.' },
      { key: 'policy', label: 'Policy application', weight: 10, text: 'Illustrative scope: apply relevant guidance consistently and document the basis for an escalation.' },
    ],
  },
  {
    ladder: 'Program management', grade: 'GS-12', scope: 'complex delivery portfolios and cross-office decisions',
    criteria: [
      { key: 'delivery', label: 'Complex program delivery', weight: 30, text: 'Illustrative scope: manage interdependent workstreams, risk responses, and delivery tradeoffs across offices.' },
      { key: 'leadership', label: 'Cross-office leadership', weight: 25, text: 'Illustrative scope: clarify decision rights, coach workstream owners, and negotiate shared priorities across teams.' },
      { key: 'analysis', label: 'Ambiguous problem analysis', weight: 20, text: 'Illustrative scope: reconcile incomplete evidence and explain the uncertainty behind a portfolio-level decision.' },
      { key: 'communication', label: 'Sponsor communication', weight: 15, text: 'Illustrative scope: present concise choices, evidence, and risks to accountable program sponsors.' },
      { key: 'policy', label: 'Program stewardship', weight: 10, text: 'Illustrative scope: maintain decision records and connect delivery practices with the applicable review controls.' },
    ],
  },
  {
    ladder: 'Technology', grade: 'GS-11', scope: 'independent implementation using established engineering practices',
    criteria: [
      { key: 'technical', label: 'Practical technical implementation', weight: 40, text: 'Illustrative scope: implement and support a documented technical solution with repeatable operating steps.' },
      { key: 'analysis', label: 'Technical troubleshooting', weight: 25, text: 'Illustrative scope: use logs or data checks to test a specific hypothesis and document the result.' },
      { key: 'delivery', label: 'Dependable technical delivery', weight: 20, text: 'Illustrative scope: plan a bounded release with a test checklist, dependencies, and a recovery option.' },
      { key: 'communication', label: 'Usable technical documentation', weight: 15, text: 'Illustrative scope: write clear runbooks and explain an implementation to its users and maintainers.' },
    ],
  },
  {
    ladder: 'Technology', grade: 'GS-12', scope: 'service ownership and dependable cross-team engineering delivery',
    criteria: [
      { key: 'technical', label: 'Service engineering depth', weight: 40, text: 'Illustrative scope: own a repeatable service design, operational checks, and evidence-backed reliability improvements.' },
      { key: 'delivery', label: 'Service lifecycle delivery', weight: 25, text: 'Illustrative scope: balance planned change with support, sequence dependencies, and verify release outcomes.' },
      { key: 'analysis', label: 'Systematic investigation', weight: 15, text: 'Illustrative scope: combine several sources of operational evidence and explain remaining uncertainty.' },
      { key: 'communication', label: 'Cross-team technical communication', weight: 10, text: 'Illustrative scope: communicate design choices, operational risks, and clear handoffs across technical teams.' },
      { key: 'policy', label: 'Technical stewardship', weight: 10, text: 'Illustrative scope: document access, change, or control decisions and seek specialist review when needed.' },
    ],
  },
  {
    ladder: 'Technology', grade: 'GS-13', scope: 'technical leadership, service-wide tradeoffs, and accountable stewardship',
    criteria: [
      { key: 'technical', label: 'Advanced service engineering', weight: 35, text: 'Illustrative scope: guide complex technical improvements and demonstrate dependable outcomes across services.' },
      { key: 'leadership', label: 'Technical program leadership', weight: 25, text: 'Illustrative scope: coach technical owners, set decision rights, and coordinate priorities across teams.' },
      { key: 'delivery', label: 'Portfolio-level technical delivery', weight: 20, text: 'Illustrative scope: sequence interdependent service improvements and manage capacity and operational tradeoffs.' },
      { key: 'policy', label: 'Risk and control accountability', weight: 10, text: 'Illustrative scope: maintain traceable risk decisions and distinguish engineering advice from formal approval.' },
      { key: 'communication', label: 'Technical sponsor briefings', weight: 10, text: 'Illustrative scope: explain service impact, uncertainty, and choices to both technical and nontechnical sponsors.' },
    ],
  },
]

export const JOB_FIXTURE_COUNT = jobDefinitions.length
export const RESUME_FIXTURE_COUNT = resumeDefinitions.length

function createJobFixture(definition: JobDefinition, index: number): { job: Job; document: SourceDocument; rubric: Rubric } {
  const base = 1000 + index * 100
  const document: SourceDocument = {
    id: seedId(base + 1),
    title: `${definition.title} · source document`,
    kind: 'job',
    version: 1,
    sample: true,
    paragraphs: [
      { id: seedId(base + 10), page: 1, heading: 'Synthetic demonstration notice', text: SYNTHETIC_NOTICE },
      { id: seedId(base + 11), page: 1, heading: 'Position and public-service mission', text: definition.overview },
      ...definition.requirements.map((requirement, criterionIndex) => ({
        id: seedId(base + 40 + criterionIndex),
        page: criterionIndex < 2 ? 1 : 2,
        heading: requirement.label,
        text: requirement.text,
      })),
    ],
  }
  const rubric: Rubric = {
    id: seedId(base + 2),
    groupId: seedId(base + 3),
    kind: 'job',
    jobId: seedId(base),
    name: `${definition.title} rubric`,
    description: `Demo-generated rubric for ${definition.organization}. Its requirements and weights are synthetic, not extracted from a real vacancy. It is an evidence-review aid, not a qualification or hiring decision.`,
    version: 1,
    createdAt: CREATED_AT,
    criteria: definition.requirements.map((requirement, criterionIndex) => ({
      id: seedId(base + 20 + criterionIndex),
      key: requirement.key,
      label: requirement.label,
      description: requirement.text,
      weight: requirement.weight,
      guidance: guidance(requirement.key),
      sourceParagraphId: seedId(base + 40 + criterionIndex),
    })),
  }
  const job: Job = {
    id: seedId(base),
    title: definition.title,
    organization: definition.organization,
    location: definition.location,
    arrangement: definition.arrangement,
    employmentType: 'Full time · synthetic vacancy',
    grade: definition.grade,
    series: definition.series,
    source: definition.source,
    sourceLabel: definition.sourceLabel,
    documentId: document.id,
    rubricId: rubric.id,
    status: 'ready',
    createdAt: CREATED_AT,
  }
  return { job, document, rubric }
}

function createResumeFixture(definition: ResumeDefinition, index: number): { resume: Resume; document: SourceDocument } {
  const base = 3000 + index * 100
  const document: SourceDocument = {
    id: seedId(base + 1),
    title: `${definition.name} · fictional resume`,
    kind: 'resume',
    version: 1,
    sample: true,
    paragraphs: [
      { id: seedId(base + 10), page: 1, heading: 'Fictional candidate notice', text: SYNTHETIC_NOTICE },
      { id: seedId(base + 11), page: 1, heading: 'Professional profile', text: definition.profile },
      ...definition.evidence.map((evidence, evidenceIndex) => ({
        id: seedId(base + 40 + evidenceIndex),
        page: evidenceIndex < 2 ? 1 : 2,
        heading: evidence.heading,
        text: evidence.text,
      })),
    ],
  }
  const evidence: Resume['evidence'] = {}
  definition.evidence.forEach((item, evidenceIndex) => {
    evidence[item.key] = { score: item.score, paragraphId: seedId(base + 40 + evidenceIndex) }
  })
  const resume: Resume = {
    id: seedId(base),
    name: definition.name,
    role: definition.role,
    location: definition.location,
    initials: definition.name.split(' ').map((part) => part[0]).join(''),
    experience: definition.experience,
    documentId: document.id,
    sourceLabel: `Synthetic ${definition.name} resume.pdf`,
    createdAt: CREATED_AT,
    sample: true,
    evidence,
  }
  return { resume, document }
}

function createGradeFixture(definition: GradeDefinition, index: number): Rubric {
  const base = 5000 + index * 100
  return {
    id: seedId(base),
    groupId: seedId(base + 1),
    kind: 'grade',
    ladder: definition.ladder,
    grade: definition.grade,
    name: `${definition.ladder} · ${definition.grade}`,
    description: `Illustrative ${definition.grade} ${definition.ladder.toLowerCase()} rubric for ${definition.scope}. This is a synthetic teaching example, not an official OPM standard, grade determination, qualification assessment, or eligibility decision. Grade examples reuse fixed evidence anchors with different criterion weights.`,
    version: 1,
    createdAt: CREATED_AT,
    criteria: definition.criteria.map((criterion, criterionIndex) => ({
      id: seedId(base + 20 + criterionIndex),
      key: criterion.key,
      label: criterion.label,
      description: criterion.text,
      weight: criterion.weight,
      guidance: `${guidance(criterion.key)} This ${definition.grade} example is illustrative only.`,
    })),
  }
}

// Fresh objects on every call keep imports and resets independent of prior edits.
export function createFixtureWorkspace(): Workspace {
  const jobs = jobDefinitions.map(createJobFixture)
  const resumes = resumeDefinitions.map(createResumeFixture)
  return {
    schemaVersion: 1,
    jobs: jobs.map((item) => item.job),
    resumes: resumes.map((item) => item.resume),
    documents: [...jobs.map((item) => item.document), ...resumes.map((item) => item.document)],
    rubrics: [...jobs.map((item) => item.rubric), ...gradeDefinitions.map(createGradeFixture)],
    runs: [],
  }
}

export function createInitialWorkspace(): Workspace {
  const workspace = createFixtureWorkspace()
  const candidateComparison = snapshotAnalysisRun(
    workspace,
    [workspace.resumes[0].id, workspace.resumes[2].id, workspace.resumes[5].id],
    [workspace.rubrics[0].id],
    'Program analyst · three fictional applicants',
    { id: seedId(7000), createdAt: '2026-09-15T13:25:00.000Z', comparisonId: (index) => seedId(7010 + index) },
  )
  const multiTargetComparison = snapshotAnalysisRun(
    workspace,
    [workspace.resumes[1].id, workspace.resumes[3].id],
    [workspace.rubrics[1].id, workspace.rubrics[3].id, workspace.rubrics[10].id, workspace.rubrics[11].id],
    'Technology and analytics · jobs + illustrative grades',
    { id: seedId(7100), createdAt: '2026-09-16T10:40:00.000Z', comparisonId: (index) => seedId(7110 + index) },
  )
  workspace.runs = [multiTargetComparison, candidateComparison].map((run) => ({
    ...run,
    comparisons: run.comparisons.map((comparison) => evaluateComparison(run, comparison.id)),
  }))
  return workspace
}
