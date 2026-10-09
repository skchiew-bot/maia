# ISO/IEC 42001:2023 Annex A: reference list and AOC mapping (provisional)

> **Status: PROVISIONAL, not reviewed against the standard.** This page was compiled on 2026-10-09 from public
> secondary sources (cited below). Nothing here was checked against the purchased ISO/IEC 42001:2023 text. Per
> AOC-SPEC-003 §13 and risk **R3**, the **compliance lead must confirm every control identifier, title and
> mapping row against the purchased standard** before the mapping page is built, cited, or embedded in an
> evidence pack as anything but provisional. The machine-readable mapping is
> [`config/iso42001-mapping.json`](../../config/iso42001-mapping.json) (`status: "provisional"`,
> `stampedBy: null`).
>
> Only control identifiers and short titles are listed; no normative text of the standard is reproduced. The
> column "What it asks" is AOC's own paraphrase, written for orientation only.

## 1. Scope assumption to confirm

The standard applies to the organisation's AI management system (AIMS). Which Annex A controls apply is decided
in the Statement of Applicability (clause 6.1.3), within the AIMS scope (clause 4.3). This mapping assumes the
following scope; the compliance lead must confirm it:

- **The AIMS covers the organisation's use of AI coding agents (Claude Code) through AOC to develop, change and
  promote software.**
- Managed agent sessions plus the AOC platform are treated as "the AI system in operation" for the A.6.2.x life-cycle
  rows.
- Anthropic is a supplier (A.10.3).

AOC produces evidence for controls. It does not by itself make the organisation conformant: the AI policy (A.2),
competence (A.4.6), societal impact assessment (A.5.5) and customer relationships (A.10.4) are organisational
duties that AOC does not cover.

## 2. Annex A: control objectives and controls

38 controls in 9 control objectives, A.2 to A.10. Two independent public lists agree on every identifier and,
apart from small wording differences, every title. The differences are noted in the table.

| ID | Control (title) | What it asks (AOC paraphrase) | AOC rows |
| --- | --- | --- | --- |
| **A.2** | **Policies related to AI** | | |
| A.2.2 | AI policy | A documented AI policy. | n/a (organisational) |
| A.2.3 | Alignment with other organizational policies | The AI policy fits the other policies. | n/a |
| A.2.4 | Review of the AI policy | Planned review of the policy. | n/a |
| **A.3** | **Internal organization** | | |
| A.3.2 | AI roles and responsibilities | Defined and allocated AI roles. | map-005 |
| A.3.3 | Reporting of concerns | A process to report concerns about the AI system. | map-027 |
| **A.4** | **Resources for AI systems** | | |
| A.4.2 | Resource documentation | Relevant resources are identified and documented. | map-017 |
| A.4.3 | Data resources | Data resources are documented. | n/a |
| A.4.4 | Tooling resources | Tooling is documented. | map-018 |
| A.4.5 | System and computing resources | Computing resources are documented. | map-019 |
| A.4.6 | Human resources | Human resources and competences are documented. | n/a (organisational) |
| **A.5** | **Assessing impacts of AI systems** | | |
| A.5.2 | AI system impact assessment process | A process to assess impacts. | map-006 |
| A.5.3 | Documentation of AI system impact assessments | Impact assessments are retained. | map-007 |
| A.5.4 | Assessing AI system impact on individuals or groups of individuals (one source shortens it) | Impact on individuals is assessed. | gap |
| A.5.5 | Assessing societal impacts of AI systems | Societal impact is assessed. | gap |
| **A.6** | **AI system life cycle** (A.6.1 management guidance for development, A.6.2 life cycle) | | |
| A.6.1.2 | Objectives for responsible development of AI system (sources vary: "…design and development…") | Objectives for responsible development. | n/a |
| A.6.1.3 | Processes for responsible AI system design and development | Defined processes for responsible design and development. | map-026 |
| A.6.2.2 | AI system requirements and specification | Requirements are specified. | n/a (plan manifest partly) |
| A.6.2.3 | Documentation of AI system design and development | Design and development are documented. | n/a |
| A.6.2.4 | AI system verification and validation | Verification and validation measures. | map-013 |
| A.6.2.5 | AI system deployment | A deployment plan with its requirements met before deployment. | map-014 |
| A.6.2.6 | AI system operation and monitoring | Operation and monitoring are defined. | map-011 |
| A.6.2.7 | AI system technical documentation | Technical documentation for interested parties. | map-003 |
| A.6.2.8 | AI system recording of event logs | Event logs are kept, at minimum while the system is in use. | map-001, map-002 |
| **A.7** | **Data for AI systems** | | |
| A.7.2 | Data for development and enhancement of AI system | Data management processes. | n/a |
| A.7.3 | Acquisition of data | How data is acquired and selected. | map-020 |
| A.7.4 | Quality of data for AI systems | Data quality requirements. | n/a |
| A.7.5 | Data provenance (one source: "Provenance of data") | Provenance is recorded. | map-021 |
| A.7.6 | Data preparation | How data is prepared. | n/a |
| **A.8** | **Information for interested parties of AI systems** | | |
| A.8.2 | System documentation and information for users | Users get the information they need. | map-016 |
| A.8.3 | External reporting | Interested parties can report adverse impacts. | n/a |
| A.8.4 | Communication of incidents | A plan to communicate incidents. | map-015 |
| A.8.5 | Information for interested parties | Obligations to report information to interested parties. | n/a |
| **A.9** | **Use of AI systems** | | |
| A.9.2 | Processes for responsible use of AI systems | Processes for responsible use. | map-023 |
| A.9.3 | Objectives for responsible use of AI system | Objectives that guide responsible use. | map-024 |
| A.9.4 | Intended use of the AI system | Use according to intended use and documentation. | map-025 |
| **A.10** | **Third-party and customer relationships** | | |
| A.10.2 | Allocating responsibilities (one source: "Allocation of responsibilities") | Responsibilities are allocated between the organisation and third parties. | n/a (see map-022 note) |
| A.10.3 | Suppliers | Supplier services align with responsible use. | map-022 |
| A.10.4 | Customers | Customer expectations and needs are considered. | n/a |

## 3. Main-clause anchors relevant to AOC

Clauses 4–10 follow the harmonized management-system structure. Titles are per the Modulos clause map and
cross-checked for 10.2.

| Clause | Title | Why it matters to AOC | AOC rows |
| --- | --- | --- | --- |
| 4.3 | Determining the scope of the AI management system | Fixes what "the AI system" is for A.6 (§1 above). | n/a (to decide) |
| 6.1.3 | AI risk treatment | Produces the Statement of Applicability that selects Annex A controls. | n/a |
| **6.1.4** | **AI system impact assessment** | Change-request impact analysis feeds it. | map-008 |
| **6.3** | **Planning of changes** | Changes to the AIMS itself must be planned: governance configuration, registry, rate card, mapping. | map-009 |
| 7.5 | Documented information | Evidence pack, chain integrity, retention and erasure. | map-004 |
| **8.1** | **Operational planning and control** | Control of planned changes and review of unintended ones: change control and the provenance gate. | map-010 |
| 8.4 | AI system impact assessment (operation) | Impact assessments repeated during operation, e.g. after major changes. | see map-008 note |
| **9.1** | **Monitoring, measurement, analysis and evaluation** | Liveness, evidence-backed progress, metering, recurrence trends. | map-012 |
| 9.2 / 9.3 | Internal audit / Management review | Evidence packs are inputs to both. | n/a |
| 10.1 | Continual improvement | Lessons registry payoff tracking. | n/a |
| **10.2** | **Nonconformity and corrective action** | Repeat-offence lifecycle with root cause and verified closure; lessons. | map-028 |

## 4. The five §13 corrections (AOC-SPEC-002 → 003)

All five are consistent with both public control lists. Each still needs confirmation against the standard.

| Topic | AOC-SPEC-002 (wrong) | Corrected | Note | Rows |
| --- | --- | --- | --- | --- |
| Event logging | A.6.2.6 | **A.6.2.8** AI system recording of event logs | A.6.2.6 is operation and monitoring, which is now the liveness row. | map-001, map-002, map-011 |
| Technical documentation | change management | **A.6.2.7** AI system technical documentation | Change management moves to clauses 6.3 and 8.1. | map-003, map-009, map-010 |
| Roles | A.5 | **A.3.2** AI roles and responsibilities | A.5 is impact assessment, now used for change-request impact analysis. | map-005, map-006 |
| Incident communication | A.8.3 | **A.8.4** Communication of incidents | A.8.3 is external reporting. | map-015 |
| Token and resource use | A.7 | **A.4** (A.4.2 resource documentation, A.4.5 system and computing resources) | A.7 is data for AI systems, now used for intake media. | map-017, map-019, map-020 |

## 5. Mapping summary (`config/iso42001-mapping.json`, version `2026.10-draft`)

| Row | AOC control | Clause |
| --- | --- | --- |
| map-001 | Hash-chained audit event log (single writer) | A.6.2.8 |
| map-002 | Off-host anchor of the nightly chain head; Verify against the anchor | A.6.2.8 |
| map-003 | Frozen ISO-mapped evidence pack | A.6.2.7 |
| map-004 | Control of documented information | 7.5 |
| map-005 | Three-role access model on a per-person identity | A.3.2 |
| map-006 | Change-request impact analysis | A.5.2 |
| map-007 | Retention of impact analyses | A.5.3 |
| map-008 | Change-request impact analysis (main clause) | 6.1.4 |
| map-009 | Planned changes to the AIMS and governance configuration | 6.3 |
| map-010 | Plan manifest, change control, gated promotion | 8.1 |
| map-011 | Liveness and operation monitoring | A.6.2.6 |
| map-012 | Measured progress, metering, recurrence trends | 9.1 |
| map-013 | Acceptance tests and UAT | A.6.2.4 |
| map-014 | Go-live gate with provenance guarantee | A.6.2.5 |
| map-015 | Break-glass plus post-incident record | A.8.4 |
| map-016 | Requester abstracted status | A.8.2 |
| map-017 | Resource documentation (registry, rate card, subscription, FX) | A.4.2 |
| map-018 | Tooling inventory per session | A.4.4 |
| map-019 | Metering of tokens, compute and throttle idle time | A.4.5 |
| map-020 | Intake media acquisition (PDPA surface) | A.7.3 |
| map-021 | Intake data provenance and erasure | A.7.5 |
| map-022 | Anthropic as supplier | A.10.3 |
| map-023 | Human-required decisions, credential isolation, read-only triage | A.9.2 |
| map-024 | Responsible-use objectives as metrics | A.9.3 |
| map-025 | Intended use via the process-type registry | A.9.4 |
| map-026 | Self-modification boundary | A.6.1.3 |
| map-027 | Reporting of concerns without blame | A.3.3 |
| map-028 | Lessons and repeat-offence corrective action | 10.2 |

Evidence entries name event types from the Wave 0 event catalog (`packages/contracts/src/events/*`, e.g.
`decision.resolved`, `anchor.created`, `chain.verified`, `evidence_pack.generated`, `throttle.hit`) and
artifacts (evidence pack, anchor receipts).

## 6. Gaps and questions for the compliance lead

1. **Scope (4.3).** Confirm the §1 assumption. In particular, decide whether the A.6.2.x life-cycle controls apply
   to agent-built software changes, or only to the agent platform itself.
2. **6.3 vs 8.1.** Clause 6.3 governs changes to the management system. Product change control fits 8.1 better.
   map-009 and map-010 split them that way; confirm.
3. **A.3.3 Reporting of concerns.** AOC has no human "raise a concern" channel and no reporter-confidentiality
   rule. Either add a decision type or rely on an organisational procedure.
4. **A.5.4 / A.5.5.** A per-change impact analysis does not cover impacts on individuals or society. If these are
   applicable, they need an organisational assessment.
5. **A.7 for intake media.** Confirm whether requester uploads (inputs to agent sessions) fall under A.7. PDPA
   duties apply regardless.
6. **A.8.4 audience.** Break-glass routes to the Approver. Communicating incidents to users and other interested
   parties needs a procedure.
7. **Retention vs erasure.** Crypto-shredding (`body.erased`) removes evidence text but keeps hashes. Agree
   retention periods for impact analyses and post-incident records.

## 7. How to stamp the mapping

1. The compliance lead reviews each row against the purchased standard and edits `clause`, `clauseTitle`,
   `evidence` and `correctionNote` as needed.
2. Set each reviewed row's `status` to `"confirmed"`, or remove the row.
3. Set the top-level `status`, `stampedBy` (person id) and `stampedAt` (ISO 8601).
4. Bump `version` (e.g. `2026.11`).
5. AOC records `mapping.published` on load and `mapping.stamped` on stamp. Evidence packs embed the version and
   the stamp ("mapping reviewed by compliance lead on X"), and are labelled provisional until then (spec §14).

## Sources

- Annex A list: riskprofs, "ISO 42001 Annex A controls list": <https://riskprofs.com/iso-42001-annex-a-controls-list/>
- Annex A list: TCSA, ISO 42001 controls: <https://www.tcsa.in/frameworks/iso-42001/controls>
- Annex A (partial; some IDs on that page do not match the two lists above, so it was not relied on): CertPro:
  <https://certpro.com/hub/iso-42001/controls/iso-42001-controls-list/>
- Clause map (4.1–10.2): Modulos docs, "ISO 42001 clauses 4–10":
  <https://docs.modulos.ai/frameworks/iso-42001/clauses-4-10.html>
- Clause 10.2: Cyberday, "ISO 42001 10.2 Nonconformity and corrective action":
  <https://www.cyberday.ai/requirement/iso-42001-10-2-nonconformity-and-corrective-action>
- Authoritative text (purchase required): ISO/IEC 42001:2023, <https://www.iso.org/standard/81230.html>
- AOC-SPEC-003 §8 (change control), §13 (audit trail and ISO 42001 corrections), §14 (evidence pack), §16
  (risk R3).
