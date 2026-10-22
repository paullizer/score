# Local applicant names in exports

Score can attach applicant names to a downloaded analysis report after evaluation,
without uploading the identifier-to-name mapping or sending it to a model.
This is useful when a separate redaction tool produces resumes such as
`Applicant 093.pdf` and an Excel spreadsheet linking those identifiers to names.

Even when unredacted resumes are imported directly into Score, extracted candidate
metadata (`name`, `location`, `displayName`, and filenames) is used only for
workspace UI display and is never passed to the analytical scoring or summary
models; `worker/analyses/pii-redaction.ts` also redacts candidate names (replacing
them with neutral `"They"` / `"their"` phrasing), email addresses, phone numbers,
street addresses, and locations from model-facing passages before assessment,
grounding review, and summary generation while resolving integer `passageId`
citations back to the original resume text for UI inspection. Combining pre-upload
redaction with local applicant-name mapping provides an additional boundary when
organizations want candidate identifiers rather than names stored in workspace records.

## Export workflow

1. Open a saved analysis and choose **Export report**. Select the report format
   and, if needed, one exact job or grade.
2. Enable **Add applicant names from a local mapping file**. Choose an Excel
   `.xlsx` workbook or a UTF-8, comma-separated `.csv` file on your computer.
3. Select the worksheet and header row, then choose different **Applicant
   identifier column** and **Full name column** fields. The workbook's column
   titles do not need to follow a fixed template. Use one column containing the
   complete name.
4. Review the match counts and preview. Counts refer to distinct applicants with
   completed reviews in the selected scope, not the number of candidate/job
   comparisons. A repeated resume across several targets has the same identity.
5. Download CSV, PDF, Word, or PowerPoint. You may change formats without
   reselecting the mapping while this dialog stays open. **Remove mapping** turns
   the option off and restores normal exports.

Names are optional. An applicant without a matching, nonblank name remains
included under their unique identifier. Partial matches and even zero matches do
not prevent download. The preview displays up to eight applicants; counts cover
the entire selected scope. HR is responsible for selecting the correct mapping
and checking it: Score cannot verify whether a syntactically valid name belongs
to the person represented by an identifier.

Existing workspace permissions, enabled report formats, scope/resource limits,
and summary-readiness rules still apply. PDF, Word, and PowerPoint still require
the selected saved summaries to be current and ready. Selecting a mapping never
starts scoring or summary generation.

## Exact matching rules

Matching uses the source filename frozen with the analysis, not an extracted
person name, internal row order, model inference, or a mutable resume display
label. Score trims surrounding whitespace and removes one trailing `.pdf`,
`.docx`, `.doc`, `.md`, or `.markdown` extension, case-insensitively, on either
side. Everything else remains significant.

| Source filename | Mapping identifier | Result |
| --- | --- | --- |
| `Applicant 093.pdf` | `Applicant 093` | Match |
| `Applicant 093.pdf` | `Applicant 093.PDF` | Match |
| `Applicant 093.pdf` | `Applicant 93` | No match |
| `Applicant 093.pdf` | `applicant 093` | No match |

Use **text cells** for identifiers and names in Excel. Score rejects selected
numeric, date, Boolean, or error cells instead of guessing formatting or lost
leading zeros. For example, Excel may store a displayed `00093` as the number
`93`; formatting an already-converted value as text does not restore the missing
zeros. Correct the actual text value or export a CSV that preserves it.

Wholly empty rows are ignored. Blank names supply no name and leave applicants
unmatched. A nonempty row without an identifier needs correction. Extra mapping
identifiers outside the selected report are unused; they never add applicants.
URL imports are not matched by guessing identifiers from URLs or extracted names;
they retain their internal resume identifier in mapping mode.

Duplicate normalized mapping identifiers and distinct resumes with the same
normalized source identifier are ambiguous and block mapped export. Fix the
mapping/source inputs or remove the mapping; Score does not pick a first or last
match. Two different identifiers may legitimately map to identical names.

## What each report contains

- **CSV:** the candidate-name field contains the mapped name or unmatched
  identifier. Mapping mode adds **Applicant identifier**, preserves **Source**
  and existing custom-label columns, and includes the local-mapping disclosure.
  Scores, assessment text, and links remain unchanged. Spreadsheet formula
  prefixes in untrusted text are escaped as in ordinary CSV exports.
- **CSV with job & rubric details:** `analyses.csv` is the same mapped CSV;
  `rubrics.csv` remains candidate-free and unchanged.
- **PDF and Word:** candidate tables and featured reviews show mapped names and
  identifiers, with a local-mapping/privacy notice. Original source labels and
  source-stated-name provenance remain separate.
- **PowerPoint:** candidate tables and featured reviews use the same local
  identities and preserve source references, with a local-mapping notice.
  Long identities can add continuation slides rather than clipping text or
  replacing it with a candidate number. Continued review material links back to
  its candidate overview.

Names are export-only labels supplied by HR, not names verified or generated by
AI. Score does not write them back to resumes, saved comparisons, immutable
snapshots, hashes, or settings. It does not alter scores, highlight selection,
source links, saved rationale, narrative prose, or evidence quotations. A saved
narrative can therefore still refer to the original anonymous identifier.
Exports without this option retain their existing schema and behavior.
Standalone rubric exports contain no candidates and do not need a mapping.

## File and processing limits

| Limit | Value |
| --- | --- |
| Selected file | 5 MiB |
| Expanded workbook data | 16 MiB |
| ZIP entries | 256 |
| Worksheets | 20 |
| Rows | 10,000 per worksheet |
| Columns | 50 |
| Total cells | 200,000, including gaps between populated cells |
| Cell text | 4,096 characters |
| Applicant identifier | 512 characters |
| Applicant name | 300 characters |
| Local parsing deadline | 30 seconds |

The reader bounds decompression before spreadsheet parsing and rejects sparse
worksheets that would require oversized dense allocations. Oversized or invalid
files fail visibly rather than omitting rows. Mapping identities also count
toward the report's captured input-byte limit.

Use plain-value `.xlsx` workbooks or UTF-8 CSV. Workbooks containing formulas,
macros, embedded objects, external workbook links, unsupported ZIP compression,
or encrypted data are not supported. Legacy `.xls` is not supported. Paste
formula results as text values into a clean workbook if necessary. CSV supports
quoted commas, escaped quotes, multiline fields, CRLF or LF, and a UTF-8 BOM;
selected identifiers and full names must still be single-line plain text.
Malformed quoting or invalid encoding is an error, not a partial import.

## Privacy boundary

The selected file is read in the browser and processed by a dedicated local
worker with network APIs disabled. Only resolved identities for the completed
export scope are passed to the local report-generation worker, also without
network access. The workbook, mapping rows, and restored names are not sent to
Score's API, a model, a conversion service, logs, analytics, or browser storage.
Normal authenticated evidence, policy, font, and summary-readiness requests still
occur; they do not carry the mapping.

Closing the dialog, leaving the analysis/workspace, losing access, removing or
replacing the mapping, or unmounting the export controls cancels pending local
parsing and releases the corresponding mapping state. Closing/navigation also
cancels pending report generation. No reusable server mapping or private
browser-storage cache is created.

Browser-only does not mean that names never touch the computer. The selected
file already exists on the HR computer, and the named download contains personal
information outside Score's access-control boundary. Protect these files,
authorized recipients, browser extensions, and managed devices under your
organization's PII rules. Releasing JavaScript references does not guarantee
physical memory erasure. Source redaction remains the responsibility of the
upstream workflow; this feature does not inspect or certify its completeness.

## Implementation notes

The local reader is lazy-loaded. `read-excel-file` interprets the workbook;
`fflate` provides streaming bounded ZIP inflation and creates an uncompressed,
already-bounded archive for that reader. `saxes`, already used by Score, checks
XML structure, formula restrictions, and worksheet allocation limits first.
No server endpoint, model resource, persistent application setting, or deployment
environment variable is introduced. Dependency versions are locked, and the
spreadsheet reader is not part of ordinary app startup or an unmapped export.
