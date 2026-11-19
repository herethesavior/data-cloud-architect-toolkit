import { Badge, Button, Panel, Tabs } from '../components/ui/index.ts';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { PageIntro } from '../components/PageIntro.tsx';
import type { Page } from '../navigation.ts';

interface HelpPageProps {
  onNavigate: (page: Page) => void;
}

const REPOSITORY_URL = 'https://github.com/herethesavior/data-cloud-architect-toolkit';
const ISSUES_URL = `${REPOSITORY_URL}/issues`;
const LINKEDIN_URL = 'https://www.linkedin.com/in/ryanjoshuadc';

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

const does: string[] = [
  'Read metadata with allowlisted, read-only Salesforce CLI commands.',
  'Show Data Spaces, DLOs, DMOs, mappings, streams, transforms, and relationships.',
  'Show source endpoint, API version, retrieval time, and confidence for metadata.',
  'Mark unsupported, forbidden, and partial results explicitly.',
  'Keep exports local and user-initiated.',
];

const doesNot: string[] = [
  'Create, update, delete, deploy, activate, ingest, or refresh org data.',
  'Query or display customer or transaction records.',
  'Invent counts, objects, or relationships.',
  'Turn a permissions problem into an empty dataset.',
  'Send org metadata to a third party.',
];

const steps: { title: string; body: string }[] = [
  {
    title: 'Choose a mode and an org',
    body: 'Demo mode uses a fully labelled sample inventory and needs no Salesforce CLI. Live mode reads an authenticated org from Salesforce CLI, or through your local bridge when you use the hosted site.',
  },
  {
    title: 'Read the supported API version',
    body: 'DCAT first asks Salesforce CLI for the latest supported API version. If that fails, it requests no metadata and explains the gap.',
  },
  {
    title: 'Probe each metadata family independently',
    body: 'Data Spaces, DLOs, DMOs, mappings, streams, and transforms are checked separately. A failure in one family does not erase successful results from another.',
  },
  {
    title: 'Show status, provenance, and gaps',
    body: 'A 403 is shown as forbidden, an unsupported endpoint as unsupported, and malformed responses as errors. Partial results are labelled, and the inventory shows where each finding came from.',
  },
  {
    title: 'Refresh or export when you choose',
    body: 'Loaded orgs and inventories are saved in this browser and restored after a reload, so menu navigation does not retrieve them again. The Updated chip shows their age; use Refresh for a token-protected retrieval. Exports stay local.',
  },
];

const glossary: { term: string; definition: string }[] = [
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
    term: 'Discovery Health',
    definition: 'The per-family status summary that distinguishes complete, partial, forbidden, unsupported, and failed retrievals.',
  },
  {
    term: 'Provenance',
    definition: 'The source endpoint, API version, retrieval time, and confidence attached to a metadata finding.',
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
  {
    title: 'Exports stay local',
    body: 'Exports are generated locally and only after you choose a format. They can still reveal internal architecture, so share them according to your organization’s policies.',
    icon: 'download',
  },
  {
    title: 'No telemetry',
    body: 'No analytics or telemetry service receives org metadata.',
    icon: 'monitor',
  },
];

export function HelpPage({ onNavigate }: HelpPageProps) {
  const tabs = [
    {
      id: 'what',
      label: 'What is DCAT?',
      content: (
        <div className="space-y-5">
          <Panel>
            <h3 className="text-lg font-semibold text-ink">A read-only workbench for Data 360 metadata</h3>
            <p className="mt-2 max-w-3xl text-sm text-ink-soft">
              DCAT helps architects see how a Data 360 model is put together. It reads configuration and schema
              metadata through Salesforce CLI on your machine. It never asks for a password, token, auth URL, or
              client secret.
            </p>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {editions.map((edition) => (
                <div key={edition.title} className="rounded-lg border border-line bg-surface-alt p-4">
                  <div className="flex items-center gap-2 text-brand">
                    <Icon name={edition.icon} size={18} />
                    <p className="font-semibold text-ink">{edition.title}</p>
                  </div>
                  <p className="mt-2 text-sm text-ink-soft">{edition.description}</p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm text-ink-soft">
              Both editions include a clearly labelled <strong className="font-semibold text-ink">Demo</strong> mode.
              Demo needs no Salesforce CLI, no org, and no network access to Salesforce.
            </p>
          </Panel>

          <Panel>
            <h3 className="text-lg font-semibold text-ink">What it does — and does not</h3>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-success/20 bg-success-soft p-4">
                <p className="flex items-center gap-2 font-semibold text-success">
                  <Icon name="check" size={17} /> DCAT does
                </p>
                <ul className="mt-3 space-y-2 text-sm text-ink-soft">
                  {does.map((item) => <li key={item} className="flex gap-2"><span aria-hidden="true">•</span><span>{item}</span></li>)}
                </ul>
              </div>
              <div className="rounded-lg border border-line bg-surface-alt p-4">
                <p className="flex items-center gap-2 font-semibold text-ink">
                  <Icon name="info" size={17} className="text-ink-soft" /> DCAT does not
                </p>
                <ul className="mt-3 space-y-2 text-sm text-ink-soft">
                  {doesNot.map((item) => <li key={item} className="flex gap-2"><span aria-hidden="true">•</span><span>{item}</span></li>)}
                </ul>
              </div>
            </div>
          </Panel>
        </div>
      ),
    },
    {
      id: 'how',
      label: 'How it works',
      content: (
        <div className="space-y-5">
          <Panel>
            <h3 className="text-lg font-semibold text-ink">From org selection to inventory</h3>
            <ol className="mt-4 space-y-3">
              {steps.map((step, index) => (
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
          </Panel>
          <Panel className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="font-semibold text-ink">Ready to look at your own metadata?</p>
              <p className="mt-1 text-sm text-ink-soft">Connect an org, or review the connector status and privacy summary.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => onNavigate('orgs')} icon={<Icon name="plug" size={16} />}>
                Open Org Connections
              </Button>
              <Button variant="secondary" onClick={() => onNavigate('settings')}>
                Settings & Diagnostics
              </Button>
            </div>
          </Panel>
        </div>
      ),
    },
    {
      id: 'glossary',
      label: 'Data Cloud glossary',
      content: (
        <div className="space-y-5">
          <Panel>
            <h3 className="text-lg font-semibold text-ink">Terms you will see in the explorers</h3>
            <dl className="mt-4 grid gap-x-8 gap-y-5 md:grid-cols-2">
              {glossary.map((entry) => (
                <div key={entry.term} className="border-l-2 border-line pl-3">
                  <dt className="text-sm font-semibold text-ink">{entry.term}</dt>
                  <dd className="mt-1 text-sm text-ink-soft">{entry.definition}</dd>
                </div>
              ))}
            </dl>
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
      id: 'privacy',
      label: 'Privacy',
      content: (
        <div className="space-y-5">
          <Panel>
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-success-soft text-success">
                <Icon name="shield" size={20} />
              </span>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-ink">Private by boundary, not by promise</h3>
                <p className="mt-1 max-w-3xl text-sm text-ink-soft">
                  Both editions keep authentication with Salesforce CLI and limit what the browser can ask for.
                  The hosted edition adds a short-lived session and an outbound bridge, but never hosts Salesforce OAuth.
                </p>
              </div>
            </div>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2">
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
            <p className="mt-2 text-sm text-ink-soft">
              Operational controls such as audit logging and a formal retention policy are not part of this release.
              Add them before using the hosted edition for regulated data. Report security issues privately through the
              repository’s security advisory feature, and never include real credentials or customer data in a report.
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
            <p className="mt-5 max-w-3xl text-sm leading-relaxed text-ink-soft">
              DCAT grew out of a simple need: make Data 360 model discovery legible without turning it into a
              credential-handling exercise. It replaces scattered CLI output and screenshots with a grounded,
              status-aware view of Data Spaces, DLOs, DMOs, mappings, streams, and transforms.
            </p>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-soft">
              The design goal is to show what metadata actually says — including gaps, unsupported endpoints, and
              provenance — while keeping authentication with Salesforce CLI and exports under the user’s control.
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
        description="Plain-language answers about DCAT, Data 360 metadata, and how your org information is handled."
        meta={<Badge tone="brand" dot>Read-only · Local-first</Badge>}
      />
      <Panel className="p-4 sm:p-5">
        <Tabs items={tabs} label="Help topics" />
      </Panel>
    </div>
  );
}
