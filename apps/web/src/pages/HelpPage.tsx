import { useEffect, useState } from 'react';
import { Badge, Button, Panel, SearchField, Tabs } from '../components/ui/index.ts';
import type { BadgeTone } from '../components/ui/index.ts';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import { pagePath } from '../navigation.ts';
import type { Page } from '../navigation.ts';

interface HelpPageProps {
  onNavigate: (page: Page) => void;
}

const REPOSITORY_URL = 'https://github.com/herethesavior/data-cloud-architect-toolkit';
const ISSUES_URL = `${REPOSITORY_URL}/issues`;
const LINKEDIN_URL = 'https://www.linkedin.com/in/ryanjoshuadc';

const TOPIC_IDS = ['start', 'connect', 'explore', 'status', 'glossary', 'about'] as const;
type TopicId = (typeof TOPIC_IDS)[number];
const DEFAULT_TOPIC: TopicId = 'start';

function topicFromUrl(): TopicId {
  const requested = new URLSearchParams(window.location.search).get('topic');
  return TOPIC_IDS.find((id) => id === requested) ?? DEFAULT_TOPIC;
}

interface ExternalLinkProps {
  href: string;
  label: string;
  description: string;
  primary?: boolean;
}

function ExternalLink({ href, label, description, primary = false }: ExternalLinkProps) {
  const openLabel = `${label} (opens in a new tab)`;
  return (
    <div className="rounded-lg border border-line bg-surface-alt p-3">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={openLabel}
        title={openLabel}
        className={`${primary ? 'btn-primary' : 'btn-secondary'} w-full`}
      >
        <span>{label}</span>
        <Icon name="arrowRight" size={16} />
      </a>
      <p className="mt-2 text-xs text-ink-soft">{description}</p>
    </div>
  );
}

function PanelTitle({ icon, title, description }: { icon: IconName; title: string; description?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
        <Icon name={icon} size={18} />
      </span>
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        {description ? <p className="mt-1 max-w-3xl text-sm text-ink-soft">{description}</p> : null}
      </div>
    </div>
  );
}

const quickAnswers = [
  {
    question: 'What do I need to get started?',
    answer: 'Nothing for demo mode — it uses labelled sample data and works offline. Live mode reads metadata through Salesforce CLI on this machine, or through your local bridge when you use the hosted site.',
  },
  {
    question: 'Can DCAT change anything in my org?',
    answer: 'No. Every command it runs is read-only. DCAT never writes, deploys, ingests, or activates metadata, and all exports are generated locally.',
  },
  {
    question: 'Where should I begin?',
    answer: 'Open the Dashboard for a health snapshot, then pick the explorer that matches your question. The Explore & trace tab maps common questions to the right view.',
  },
  {
    question: 'Will I see customer or transaction records?',
    answer: 'Never. DCAT reads configuration and schema metadata only.',
  },
];

const firstSteps: { title: string; body: string; action: string; page: Page }[] = [
  {
    title: 'Explore the sample inventory',
    body: 'Start in demo mode. No Salesforce CLI, org, or network access to Salesforce is needed.',
    action: 'Open Dashboard',
    page: 'dashboard',
  },
  {
    title: 'Follow one path end to end',
    body: 'Trace a source connector through streams, DLOs, transforms, and DMOs in a single grounded view.',
    action: 'Open Data Lineage Explorer',
    page: 'lineage',
  },
  {
    title: 'Bring your own org',
    body: 'Connect an org, then check Discovery Health before you trust what an explorer is showing you.',
    action: 'Open Org Connections',
    page: 'orgs',
  },
];

const editions: { title: string; description: string; icon: IconName }[] = [
  {
    title: 'Local edition',
    description: 'The full workbench runs on your computer. Salesforce login happens in Salesforce CLI on that same machine.',
    icon: 'monitor',
  },
  {
    title: 'Hosted edition',
    description: 'The public site is paired with a small local bridge. Salesforce login still happens in Salesforce CLI on the machine running that bridge.',
    icon: 'plug',
  },
];

const connectSteps = [
  {
    title: 'Pick a mode',
    body: 'Use the switch in the header. Demo needs no setup; live reads an authenticated org from Salesforce CLI, or from the local bridge when hosted.',
  },
  {
    title: 'Select an org',
    body: 'Choose an alias in the header picker, or connect a new one in Org Connections. Credentials stay in Salesforce CLI — DCAT never sees them.',
  },
  {
    title: 'Check Discovery Health',
    body: 'Each metadata family reports its own status. A failure in one family never hides successful results from another.',
  },
];

const statusRows: { status: string; tone: BadgeTone; meaning: string; action: string }[] = [
  {
    status: 'Complete',
    tone: 'success',
    meaning: 'Every object in the family was retrieved.',
    action: 'No action needed.',
  },
  {
    status: 'Partial',
    tone: 'warning',
    meaning: 'Some objects were retrieved and the rest are listed as gaps.',
    action: 'Review the gaps, then retry that family.',
  },
  {
    status: 'Forbidden',
    tone: 'danger',
    meaning: 'The CLI user lacks permission for this endpoint.',
    action: 'Ask your admin for metadata API access. Other families keep their results.',
  },
  {
    status: 'Unsupported',
    tone: 'neutral',
    meaning: 'This API version does not expose the endpoint.',
    action: 'Check the supported API version in Settings & Diagnostics.',
  },
  {
    status: 'Failed',
    tone: 'danger',
    meaning: 'The request errored before it could finish.',
    action: 'Retry from the inventory, then check diagnostics if it repeats.',
  },
  {
    status: 'Stale',
    tone: 'warning',
    meaning: 'The saved snapshot is older than expected.',
    action: 'Use Refresh to retrieve it again.',
  },
];

const explorerRows: { question: string; label: string; shows: string; page: Page }[] = [
  {
    question: 'What objects exist, and which fields do they have?',
    label: 'DLO Explorer',
    shows: 'Ingested objects with fields and provenance',
    page: 'dlos',
  },
  {
    question: 'How is a unified model structured?',
    label: 'DMO Explorer',
    shows: 'Model objects, fields, and relationships',
    page: 'dmos',
  },
  {
    question: 'How do fields move from source to target?',
    label: 'Mapping Explorer',
    shows: 'Grounded field-level mappings',
    page: 'mappings',
  },
  {
    question: 'Where does ingested data land?',
    label: 'Data Stream Explorer',
    shows: 'Connectors, target DLOs, cadence, and status',
    page: 'data-streams',
  },
  {
    question: 'What prepares the data before it is modelled?',
    label: 'Data Transform Explorer',
    shows: 'Definitions, lineage, schedules, and run history',
    page: 'data-transforms',
  },
  {
    question: 'How do objects relate to one another?',
    label: 'ERD Explorer',
    shows: 'Confirmed and inferred relationships',
    page: 'erd',
  },
  {
    question: 'What is the whole path, end to end?',
    label: 'Data Lineage Explorer',
    shows: 'Sources → streams → DLOs → transforms → DMOs',
    page: 'lineage',
  },
];

const linkLegend = [
  {
    className: 'border-solid',
    label: 'Named in metadata',
    detail: 'The link is written in the current snapshot — for example a stream target or a declared mapping.',
  },
  {
    className: 'border-dashed',
    label: 'Derived by DCAT',
    detail: 'DCAT joined grounded references into a relationship. It is labelled as derived, never presented as a declared edge.',
  },
  {
    className: 'border-dotted',
    label: 'Missing reference',
    detail: 'Metadata names an object that is absent from this snapshot. It appears as a gap, not as an invented node.',
  },
];

const navigationTips = [
  'Search metadata from anywhere with Ctrl K (⌘K on Mac).',
  'Filter and search inside each explorer instead of scanning every row.',
  'On the canvases, drag nodes, zoom, pan, and use Fit to frame the graph.',
  'Filters, layout, positions, and viewport persist per org, so returning to a view keeps your place.',
  'Exports are generated locally and only when you choose a format.',
];

const evidenceItems = [
  {
    title: 'Source-named',
    icon: 'check' as const,
    body: 'The object or link is explicitly present in the metadata returned by Salesforce CLI.',
  },
  {
    title: 'Derived',
    icon: 'route' as const,
    body: 'DCAT connected two grounded facts. Derived items are labelled and can be filtered out.',
  },
  {
    title: 'Gap',
    icon: 'warning' as const,
    body: 'A reference points to something the snapshot does not contain. DCAT shows the missing name instead of guessing.',
  },
];

const privacyItems: { title: string; body: string; icon: IconName }[] = [
  {
    title: 'Salesforce CLI owns login',
    body: 'DCAT never asks for or stores usernames, passwords, security tokens, SFDX auth URLs, client IDs, client secrets, or encryption keys.',
    icon: 'lock',
  },
  {
    title: 'The browser never runs sf',
    body: 'Hosted mode uses an outbound bridge that polls the Worker over HTTPS. No inbound port or tunnel to your machine is opened.',
    icon: 'shield',
  },
  {
    title: 'Typed operations only',
    body: 'The relay accepts only cli.status, org.list, org.connect, inventory.get, transform.get, and mode.set. There is no arbitrary command, URL proxy, shell, or SOQL.',
    icon: 'route',
  },
  {
    title: 'Output is redacted',
    body: 'CLI output and error payloads are sanitized before they are returned or stored. The connector never reads the Salesforce CLI credential store.',
    icon: 'check',
  },
  {
    title: 'Hosted sessions expire',
    body: 'A session uses an HttpOnly, Secure, SameSite cookie. KV holds session and relay state, not Salesforce credentials, and sessions expire automatically.',
    icon: 'clock',
  },
  {
    title: 'No hosted OAuth',
    body: '/api/auth/* routes are intentionally removed and return 404. Demo data is labelled Demo and never appears under a live label.',
    icon: 'info',
  },
];

const glossaryGroups: { title: string; terms: { term: string; definition: string }[] }[] = [
  {
    title: 'Data model',
    terms: [
      {
        term: 'Data Space',
        definition: 'A logical boundary that groups metadata objects and defines ownership in Data 360.',
      },
      {
        term: 'Data Lake Object (DLO)',
        definition: 'A raw ingested object. DLOs are the starting point for most source-to-target lineage in DCAT.',
      },
      {
        term: 'Data Model Object (DMO)',
        definition: 'A unified model object that downstream Data 360 experiences consume.',
      },
      {
        term: 'Mapping',
        definition: 'A grounded source-to-target relationship, usually from DLO fields to DMO fields. DCAT does not infer mappings that metadata does not provide.',
      },
    ],
  },
  {
    title: 'Movement',
    terms: [
      {
        term: 'Data Stream',
        definition: 'An ingestion path with a source connector, target DLO, status, and cadence when those details are exposed.',
      },
      {
        term: 'Data Transform',
        definition: 'A batch or streaming step that prepares data. DCAT shows its definition, lineage, schedule, and run history only when metadata exposes them.',
      },
      {
        term: 'ERD Explorer',
        definition: 'A relationship view that separates confirmed and inferred edges and lets you filter by certainty.',
      },
      {
        term: 'Data Lineage Explorer',
        definition: 'An end-to-end view of source systems, streams, DLOs, mappings, transforms, and DMOs. Solid links are named in metadata, dashed links are derived, and missing references appear as gaps.',
      },
    ],
  },
  {
    title: 'Evidence & health',
    terms: [
      {
        term: 'Discovery Health',
        definition: 'The per-family status summary that distinguishes complete, partial, forbidden, unsupported, and failed retrievals.',
      },
      {
        term: 'Provenance',
        definition: 'The source endpoint, API version, retrieval time, and confidence attached to a metadata finding.',
      },
      {
        term: 'Gap',
        definition: 'A metadata reference to an object that is not present in the loaded snapshot. Gaps are shown explicitly so a missing answer is never mistaken for an empty result.',
      },
      {
        term: 'Source-named link',
        definition: 'A relationship written directly in the metadata, shown with a solid line in the explorers.',
      },
    ],
  },
];

export function HelpPage({ onNavigate }: HelpPageProps) {
  const [activeTopic, setActiveTopic] = useState<TopicId>(topicFromUrl);
  const [termFilter, setTermFilter] = useState('');

  useEffect(() => {
    const syncTopicFromUrl = () => setActiveTopic(topicFromUrl());
    window.addEventListener('popstate', syncTopicFromUrl);
    return () => window.removeEventListener('popstate', syncTopicFromUrl);
  }, []);

  const changeTopic = (id: string) => {
    const next = TOPIC_IDS.find((topic) => topic === id) ?? DEFAULT_TOPIC;
    setActiveTopic(next);
    const url = new URL(window.location.href);
    if (next === DEFAULT_TOPIC) url.searchParams.delete('topic');
    else url.searchParams.set('topic', next);
    url.pathname = pagePath('help');
    url.hash = '';
    window.history.pushState(null, '', `${url.pathname}${url.search}`);
  };

  const query = termFilter.trim().toLowerCase();
  const matchedGroups = glossaryGroups
    .map((group) => ({
      ...group,
      terms: group.terms.filter((term) => `${term.term} ${term.definition}`.toLowerCase().includes(query)),
    }))
    .filter((group) => group.terms.length > 0);
  const matchedTerms = matchedGroups.reduce((total, group) => total + group.terms.length, 0);

  const tabs = [
    {
      id: 'start',
      label: 'Start here',
      content: (
        <div className="space-y-5">
          <Panel>
            <PanelTitle
              icon="info"
              title="Quick answers"
              description="The four questions people ask most before they explore a real org."
            />
            <dl className="mt-4 space-y-3">
              {quickAnswers.map((item) => (
                <div key={item.question} className="rounded-lg border border-line bg-surface-alt p-3">
                  <dt className="text-sm font-semibold text-ink">{item.question}</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-ink-soft">{item.answer}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel>
            <PanelTitle
              icon="dashboard"
              title="Your first five minutes"
              description="Each step opens the view it describes, so you can follow along immediately."
            />
            <ol className="mt-4 space-y-3">
              {firstSteps.map((step, index) => (
                <li key={step.title} className="grid gap-3 rounded-lg border border-line bg-surface-alt p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="flex min-w-0 gap-3">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-brand">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{step.title}</p>
                      <p className="mt-1 text-sm text-ink-soft">{step.body}</p>
                    </div>
                  </div>
                  <Button variant="secondary" onClick={() => onNavigate(step.page)} className="sm:justify-self-end">
                    {step.action}
                  </Button>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      ),
    },
    {
      id: 'connect',
      label: 'Connect & refresh',
      content: (
        <div className="space-y-5">
          <Panel>
            <PanelTitle icon="plug" title="Two editions, one workflow" description="Both editions read the same metadata and offer the same labelled demo mode." />
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {editions.map((edition) => (
                <div key={edition.title} className="rounded-lg border border-line bg-surface-alt p-4">
                  <p className="flex items-center gap-2 font-semibold text-ink">
                    <Icon name={edition.icon} size={18} className="text-brand" />
                    {edition.title}
                  </p>
                  <p className="mt-2 text-sm text-ink-soft">{edition.description}</p>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <PanelTitle icon="layers" title="Connect in three steps" />
            <ol className="mt-4 space-y-3">
              {connectSteps.map((step, index) => (
                <li key={step.title} className="flex gap-3 rounded-lg border border-line bg-surface-alt p-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-brand">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{step.title}</p>
                    <p className="mt-1 text-sm text-ink-soft">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => onNavigate('orgs')} icon={<Icon name="plug" size={16} />}>
                Open Org Connections
              </Button>
              <Button variant="secondary" onClick={() => onNavigate('settings')}>
                Settings & Diagnostics
              </Button>
            </div>
          </Panel>

          <Panel>
            <PanelTitle
              icon="refresh"
              title="Refresh and caching"
              description="DCAT first asks Salesforce CLI for the latest supported API version. If that fails, it requests no metadata and explains the gap."
            />
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-ink-soft">
              Loaded orgs and inventories are saved in this browser and restored after a reload, so menu navigation does not
              retrieve them again. The Updated chip shows their age. Use Refresh for a token-protected retrieval; you can
              cancel an in-flight refresh, and a failure in one metadata family never erases another family’s results.
            </p>
          </Panel>

          <Panel>
            <PanelTitle
              icon="warning"
              title="Statuses, explained"
              description="Find the label in Discovery Health, then use the last column as your next step."
            />
            <ul className="mt-4 space-y-2">
              {statusRows.map((row) => (
                <li key={row.status} className="grid gap-2 rounded-lg border border-line bg-surface-alt p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <div className="flex items-center gap-2">
                    <Badge tone={row.tone} dot>{row.status}</Badge>
                    <span className="text-xs text-ink-soft">{row.meaning}</span>
                  </div>
                  <p className="text-sm text-ink-soft">{row.action}</p>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      ),
    },
    {
      id: 'explore',
      label: 'Explore & trace',
      content: (
        <div className="space-y-5">
          <Panel>
            <PanelTitle
              icon="graph"
              title="Pick the view for your question"
              description="Every view reads the same snapshot, so a finding in one explorer matches the others."
            />
            <ul className="mt-4 space-y-2">
              {explorerRows.map((row) => (
                <li key={row.label} className="grid gap-3 rounded-lg border border-line bg-surface-alt p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{row.question}</p>
                    <p className="mt-1 text-xs text-ink-soft">{row.label} · {row.shows}</p>
                  </div>
                  <Button variant="quiet" onClick={() => onNavigate(row.page)} className="sm:justify-self-end">
                    Open
                    <Icon name="arrowRight" size={15} />
                  </Button>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel>
            <PanelTitle
              icon="route"
              title="Read the links honestly"
              description="Line style tells you how strongly a connection is grounded. DCAT never joins objects just because their names look alike."
            />
            <ul className="mt-4 space-y-3">
              {linkLegend.map((item) => (
                <li key={item.label} className="flex gap-3 rounded-lg border border-line bg-surface-alt p-3">
                  <span aria-hidden="true" className={`mt-3 h-0 w-8 shrink-0 border-t-2 ${item.className} border-brand`} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{item.label}</p>
                    <p className="mt-1 text-sm text-ink-soft">{item.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel>
            <PanelTitle icon="search" title="Get around faster" />
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {navigationTips.map((tip) => (
                <li key={tip} className="flex gap-2 rounded-lg border border-line bg-surface-alt p-3 text-sm text-ink-soft">
                  <Icon name="check" size={15} className="mt-0.5 shrink-0 text-success" />
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      ),
    },
    {
      id: 'status',
      label: 'Status & privacy',
      content: (
        <div className="space-y-5">
          <Panel>
            <PanelTitle
              icon="shield"
              title="How DCAT labels evidence"
              description="A missing answer is shown as missing, never quietly replaced with a guess."
            />
            <ul className="mt-4 grid gap-3 sm:grid-cols-3">
              {evidenceItems.map((item) => (
                <li key={item.title} className="rounded-lg border border-line bg-surface-alt p-3">
                  <p className="flex items-center gap-2 font-medium text-ink">
                    <Icon name={item.icon} size={16} className="text-ink-soft" />
                    {item.title}
                  </p>
                  <p className="mt-1 text-sm text-ink-soft">{item.body}</p>
                </li>
              ))}
            </ul>
            <p className="mt-4 max-w-3xl text-sm text-ink-soft">
              Read metadata with allowlisted, read-only Salesforce CLI commands. DCAT shows the source endpoint,
              API version, retrieval time, and confidence behind a finding, and it marks unsupported, forbidden, and
              partial results explicitly.
            </p>
          </Panel>

          <Panel>
            <PanelTitle icon="lock" title="Privacy by boundary" description="Concretely, what DCAT can and cannot reach." />
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {privacyItems.map((item) => (
                <li key={item.title} className="rounded-lg border border-line bg-surface-alt p-3">
                  <p className="flex items-center gap-2 font-medium text-ink">
                    <Icon name={item.icon} size={16} className="text-ink-soft" />
                    {item.title}
                  </p>
                  <p className="mt-1 text-sm text-ink-soft">{item.body}</p>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel className="border-warning/20 bg-warning-soft">
            <h3 className="flex items-center gap-2 font-semibold text-ink">
              <Icon name="warning" size={17} className="text-warning" /> Limits to know
            </h3>
            <p className="mt-2 max-w-3xl text-sm text-ink-soft">
              Operational controls such as audit logging and a formal retention policy are not part of this release.
              Add them before using the hosted edition for regulated data. Report security issues privately through the
              repository’s security advisory feature, and never include real credentials or customer data in a report.
            </p>
          </Panel>
        </div>
      ),
    },
    {
      id: 'glossary',
      label: 'Glossary',
      content: (
        <div className="space-y-5">
          <Panel>
            <PanelTitle
              icon="book"
              title="Terms you will see in the explorers"
              description="Filter by term or definition, or browse by group."
            />
            <SearchField
              className="mt-4 max-w-sm"
              value={termFilter}
              onChange={setTermFilter}
              label="Filter glossary terms"
              placeholder="Filter terms…"
            />
            <p className="mt-2 text-xs text-ink-soft" aria-live="polite">
              Showing {matchedTerms} of {glossaryGroups.reduce((total, group) => total + group.terms.length, 0)} terms
            </p>
            {matchedGroups.length > 0 ? (
              <div className="mt-4 space-y-5">
                {matchedGroups.map((group) => (
                  <section key={group.title}>
                    <h4 className="label-xs">{group.title}</h4>
                    <dl className="mt-2 grid gap-x-8 gap-y-4 md:grid-cols-2">
                      {group.terms.map((entry) => (
                        <div key={entry.term} className="border-l-2 border-line pl-3">
                          <dt className="text-sm font-semibold text-ink">{entry.term}</dt>
                          <dd className="mt-1 text-sm text-ink-soft">{entry.definition}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </div>
            ) : (
              <p className="mt-4 rounded-lg border border-line bg-surface-alt p-3 text-sm text-ink-soft">
                No glossary terms match “{termFilter}”. Try a shorter word such as “mapping” or “gap”.
              </p>
            )}
          </Panel>
          <Panel className="flex items-start gap-3 border-info/20 bg-info-soft">
            <Icon name="info" size={18} className="mt-0.5 shrink-0 text-info" />
            <p className="text-sm text-ink-soft">
              DCAT shows configuration and schema metadata only. It never queries or displays customer records.
            </p>
          </Panel>
        </div>
      ),
    },
    {
      id: 'about',
      label: 'About & contact',
      content: (
        <div className="space-y-5">
          <Panel>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-brand-soft text-base font-semibold text-brand">
                RJ
              </span>
              <div className="min-w-0">
                <p className="label-xs">Created by</p>
                <h3 className="mt-1 text-lg font-semibold text-ink">Ryan Joshua Dela Cruz</h3>
                <p className="mt-0.5 text-sm font-medium text-brand">Technical Architect at Salesforce</p>
              </div>
            </div>
            <p className="mt-5 max-w-3xl text-sm font-medium text-brand">
              See the architecture. Understand the connections. Make better decisions.
            </p>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-soft">
              <strong className="font-semibold text-ink">Data Cloud Architect Toolkit (DCAT)</strong> is a
              local-first, read-only workbench designed to make Salesforce Data Cloud (Data 360) architectures
              easier to explore, understand, and validate.
            </p>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-soft">
              It brings together Data Spaces, data streams, DLOs, DMOs, mappings, and transformations into a
              connected architectural view. With interactive data models, lineage, and metadata explorers,
              architects can trace relationships, understand dependencies, identify gaps, and turn complex
              implementations into clear, actionable insights.
            </p>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-soft">
              Built with security and transparency in mind, DCAT relies on Salesforce CLI for authentication,
              distinguishes confirmed relationships from inferred ones, and keeps metadata discovery and exports
              under the user&apos;s control.
            </p>
            <p className="mt-4 rounded-lg border border-line bg-surface-alt px-3 py-2 text-xs text-ink-soft">
              Created in a personal capacity. DCAT is not an official Salesforce product.
            </p>
          </Panel>

          <Panel>
            <h3 className="text-lg font-semibold text-ink">Get in touch</h3>
            <p className="mt-1 text-sm text-ink-soft">
              Bug reports and feature requests are best tracked in the repository. For professional background, use
              LinkedIn. Both links open in a new tab.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <ExternalLink
                href={ISSUES_URL}
                label="Open GitHub Issues"
                description="Report a bug, request a feature, or ask a question."
                primary
              />
              <ExternalLink
                href={REPOSITORY_URL}
                label="View the repository"
                description="Source, setup instructions, and release notes."
              />
              <ExternalLink
                href={LINKEDIN_URL}
                label="Connect on LinkedIn"
                description="Professional profile and background."
              />
            </div>
          </Panel>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageIntro
        title="Help & documentation"
        description="Start with a quick answer, find the right explorer, then understand how DCAT labels evidence."
        meta={<Badge tone="brand" dot>Read-only · Local-first</Badge>}
      />
      <Panel className="p-4 sm:p-5">
        <Tabs items={tabs} label="Help topics" activeId={activeTopic} onActiveChange={changeTopic} />
      </Panel>
    </div>
  );
}
