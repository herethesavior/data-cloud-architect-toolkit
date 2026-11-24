import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PageIntro } from '../components/PageIntro.tsx';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { Badge, Button, Panel } from '../components/ui/index.ts';
import type { Page } from '../navigation.ts';

interface AboutPageProps {
  onNavigate: (page: Page) => void;
}

const REPOSITORY_URL = 'https://github.com/herethesavior/data-cloud-architect-toolkit';
const WORKBENCH_URL = 'https://sfdcat.pages.dev';

type PillTone = 'brand' | 'info' | 'violet' | 'success' | 'warning' | 'neutral';

const pillTones: Record<PillTone, string> = {
  brand: 'story-pill-brand',
  info: 'story-pill-info',
  violet: 'story-pill-violet',
  success: 'story-pill-success',
  warning: 'story-pill-warning',
  neutral: 'story-pill-neutral',
};

interface Chapter {
  id: string;
  eyebrow: string;
  shortTitle: string;
  title: ReactNode;
  lead?: string;
  body: ReactNode;
  note?: string;
  /** Shorter copy used in Present mode so the fixed slide frame stays readable. */
  presentLead?: string;
  presentNote?: string;
  /** Presentation-only layout and composition; the story page keeps the original body. */
  presentLayout?: string;
  presentBody?: ReactNode;
}

function Accent({ children }: { children: ReactNode }) {
  return <span className="story-accent">{children}</span>;
}

function Pills({ items }: { items: { label: string; tone: PillTone }[] }) {
  return (
    <div className="story-pills">
      {items.map((item) => (
        <span key={item.label} className={`story-pill ${pillTones[item.tone]}`}>
          {item.label}
        </span>
      ))}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="story-note">{children}</p>;
}

function OutcomeStrip({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="story-outcome">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function StoryCard({ icon, tag, title, children }: { icon?: IconName; tag?: string; title: string; children: ReactNode }) {
  return (
    <div className="story-card">
      {icon ? (
        <span className="story-card-icon">
          <Icon name={icon} size={18} />
        </span>
      ) : null}
      {tag ? <p className="story-tag">{tag}</p> : null}
      <h4 className="story-card-title">{title}</h4>
      <p className="story-card-text">{children}</p>
    </div>
  );
}

function NumberedRow({ number, title, detail }: { number: string; title: string; detail?: string }) {
  return (
    <div className="story-row">
      <span className="story-row-num">{number}</span>
      <strong className="story-row-title">{title}</strong>
      {detail ? <span className="story-row-detail">{detail}</span> : null}
    </div>
  );
}

function FlowNode({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return (
    <div className="story-flow-node">
      <Icon name={icon} size={19} className="story-flow-icon" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function Step({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <div className="story-step">
      <span className="story-step-num">{number}</span>
      <strong className="story-step-title">{title}</strong>
      <p className="story-step-text">{children}</p>
    </div>
  );
}

function CheckItem({ children }: { children: ReactNode }) {
  return (
    <div className="story-check">
      <span className="story-check-mark">
        <Icon name="check" size={11} />
      </span>
      <span>{children}</span>
    </div>
  );
}

function LegendRow({ line, title, detail }: { line: string; title: string; detail: string }) {
  return (
    <div className="story-legend-row">
      <span className={`story-legend-line ${line}`} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function RoadmapColumn({ kicker, title, description, current = false, items }: {
  kicker: string;
  title: string;
  description: string;
  current?: boolean;
  items: { title: string; detail: string }[];
}) {
  return (
    <div className={`story-roadmap-col ${current ? 'story-roadmap-current' : ''}`}>
      <p className="story-roadmap-kicker">{kicker}</p>
      <h4 className="story-card-title">{title}</h4>
      <p className="story-card-text">{description}</p>
      <div className="story-roadmap-items">
        {items.map((item) => (
          <div key={item.title} className="story-roadmap-item">
            <strong>{item.title}</strong>
            <span>{item.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SlideLabel({ children }: { children: ReactNode }) {
  return <p className="slide-label">{children}</p>;
}

function SlideLine({ index, title, detail }: { index: string; title: string; detail?: string }) {
  return (
    <div className="slide-line">
      <span className="slide-line-index">{index}</span>
      <strong className="slide-line-title">{title}</strong>
      {detail ? <span className="slide-line-detail">{detail}</span> : null}
    </div>
  );
}

function SlidePanel({ label, title, children, tone }: {
  label: string;
  title?: string;
  children: ReactNode;
  tone?: 'brand' | 'success' | 'neutral';
}) {
  return (
    <section className={`slide-panel ${tone ? `slide-panel-${tone}` : 'slide-panel-neutral'}`}>
      <SlideLabel>{label}</SlideLabel>
      {title ? <h4 className="slide-panel-title">{title}</h4> : null}
      <div className="slide-panel-body">{children}</div>
    </section>
  );
}

function SlideStage({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return (
    <div className="slide-stage">
      <Icon name={icon} size={19} className="slide-stage-icon" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function SlidePhase({ kicker, title, description, items, current = false }: {
  kicker: string;
  title: string;
  description: string;
  items: { title: string; detail: string }[];
  current?: boolean;
}) {
  return (
    <div className={`slide-phase ${current ? 'slide-phase-current' : ''}`}>
      <SlideLabel>{kicker}</SlideLabel>
      <h4 className="slide-phase-title">{title}</h4>
      <p className="slide-phase-description">{description}</p>
      <ul className="slide-phase-items">
        {items.map((item) => (
          <li key={item.title}>
            <strong>{item.title}</strong>
            <span>{item.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArchitectureArt({ present = false }: { present?: boolean }) {
  // The Present viewBox and node layout are tuned for the landscape slide frame.
  const nodeWidth = present ? 140 : 116;
  const nodeHeight = present ? 104 : 70;
  // Present uses a wider 5+2 composition so the same seven stages fill the
  // landscape slide frame instead of leaving large empty gutters.
  const nodes = present
    ? [
      { x: 30, y: 36, label: 'SOURCE', sub: 'Systems' },
      { x: 205, y: 36, label: 'STREAMS', sub: 'Ingestion' },
      { x: 380, y: 36, label: 'DLOS', sub: 'Landing data' },
      { x: 555, y: 36, label: 'MAPPINGS', sub: 'Transforms' },
      { x: 730, y: 36, label: 'DMOS', sub: 'Data model' },
      { x: 380, y: 268, label: 'LINEAGE', sub: 'Dependencies' },
      { x: 730, y: 268, label: 'INSIGHT', sub: 'Architecture view' },
    ]
    : [
      { x: 252, y: 38, label: 'SOURCE', sub: 'Systems' },
      { x: 107, y: 137, label: 'STREAMS', sub: 'Ingestion' },
      { x: 397, y: 137, label: 'DLOS', sub: 'Landing data' },
      { x: 252, y: 205, label: 'MAPPINGS', sub: 'Transforms' },
      { x: 107, y: 288, label: 'DMOS', sub: 'Data model' },
      { x: 397, y: 288, label: 'LINEAGE', sub: 'Dependencies' },
      { x: 252, y: 372, label: 'INSIGHT', sub: 'Architecture view' },
    ];

  return (
    <svg
      className="story-art"
      viewBox={present ? '20 24 860 360' : '0 0 620 500'}
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="dcat-architecture-edge" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-brand)" />
          <stop offset="100%" stopColor="var(--color-violet)" />
        </linearGradient>
        <linearGradient id="dcat-architecture-node" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-brand)" />
          <stop offset="100%" stopColor="var(--color-info)" />
        </linearGradient>
      </defs>
      <g>
        <g stroke="url(#dcat-architecture-edge)" strokeWidth="1.5" opacity="0.65">
          {present ? (
            <>
              <path d="M170 88H205M345 88H380M520 88H555M695 88H730" />
              <path d="M450 140V268M800 140V268M520 320H730" opacity="0.6" />
              <path d="M625 140V204H450" opacity="0.4" strokeDasharray="5 7" />
            </>
          ) : (
            <>
              <path d="M310 74 165 157 165 310 310 393 455 310 455 157 310 74Z" />
              <path d="M165 157 310 240 455 157M310 240v153M165 310l145-70 145 70" opacity="0.6" />
              <path d="M92 242 165 200 238 242M382 242l73-42 73 42M238 326l72 42 72-42" opacity="0.4" strokeDasharray="5 7" />
            </>
          )}
        </g>
        <g fill="var(--color-surface)" stroke="url(#dcat-architecture-node)" strokeWidth="1.5">
          {nodes.map((node) => (
            <rect key={node.label} x={node.x} y={node.y} width={nodeWidth} height={nodeHeight} rx="15" />
          ))}
        </g>
        <g fill="var(--color-ink)" textAnchor="middle" fontFamily="inherit">
          {nodes.map((node) => (
            <g key={node.label}>
              <text
                x={node.x + nodeWidth / 2}
                y={node.y + (present ? 44 : 28)}
                fontSize={present ? 14 : 11}
                fontWeight="700"
              >
                {node.label}
              </text>
              <text
                x={node.x + nodeWidth / 2}
                y={node.y + (present ? 68 : 45)}
                fontSize={present ? 12 : 9}
                fill="var(--color-ink-soft)"
              >
                {node.sub}
              </text>
            </g>
          ))}
        </g>
        <circle cx={present ? 450 : 310} cy={present ? 204 : 240} r="8" fill="var(--color-brand)" />
        <circle cx={present ? 450 : 310} cy={present ? 204 : 240} r="17" stroke="var(--color-brand)" strokeOpacity="0.35" />
      </g>
    </svg>
  );
}

function MockScreen() {
  return (
    <div className="story-mock" aria-label="Illustrative DCAT workbench layout">
      <div className="story-mock-top">
        <span>DCAT / DISCOVERY OVERVIEW</span>
        <span className="story-mock-badge">DEMO DATA</span>
      </div>
      <div className="story-mock-kpis">
        <div><strong>08</strong><span>DLOs</span></div>
        <div><strong>08</strong><span>DMOs</span></div>
        <div><strong>06</strong><span>Streams</span></div>
        <div><strong>05</strong><span>Transforms</span></div>
      </div>
      <div className="story-mock-flow">
        {['Sources', 'Streams', 'DLOs', 'Mappings', 'DMOs', 'Transforms'].map((label) => (
          <div key={label}><strong>{label}</strong><span>Stage</span></div>
        ))}
      </div>
    </div>
  );
}

const chapters: Chapter[] = [
  {
    id: 'idea',
    eyebrow: 'A clearer view of Data Cloud',
    shortTitle: 'Big idea',
    title: <>See the <Accent>architecture</Accent> behind the data.</>,
    lead: 'DCAT helps Salesforce Data Cloud architects discover how an environment is put together, trace how data moves, and explain the architecture with confidence.',
    presentLead: 'DCAT helps Salesforce Data Cloud architects discover how an environment is put together, trace how data moves, and explain the architecture with confidence.',
    body: (
      <div className="story-cover">
        <div>
          <p className="story-tagline">See the architecture. Understand the connections. Make better decisions.</p>
          <Pills items={[
            { label: 'Local-first', tone: 'brand' },
            { label: 'Read-only', tone: 'info' },
            { label: 'Evidence-led', tone: 'violet' },
          ]} />
          <div className="story-cover-foot">
            <span>Discover</span><i /><span>Understand</span><i /><span>Validate</span>
          </div>
        </div>
        <ArchitectureArt />
      </div>
    ),
    presentNote: 'A local-first, read-only way to see how a Data Cloud org fits together.',
    presentLayout: 'cover',
    presentBody: (
      <div className="slide-cover">
        <div className="slide-cover-copy">
          <Pills items={[
            { label: 'Local-first', tone: 'brand' },
            { label: 'Read-only', tone: 'info' },
            { label: 'Evidence-led', tone: 'violet' },
          ]} />
          <p className="slide-cover-summary">
            Trace the Data Cloud architecture from source to insight, with the evidence behind every connection.
          </p>
          <div className="slide-cover-steps">
            <span>Discover</span><span>Understand</span><span>Validate</span>
          </div>
        </div>
        <div className="slide-visual"><ArchitectureArt present /></div>
      </div>
    ),
  },
  {
    id: 'problem',
    eyebrow: 'The problem',
    shortTitle: 'Problem',
    title: <>The architecture exists. <Accent>Understanding it takes work.</Accent></>,
    lead: 'Data Cloud brings together many connected building blocks. Understanding the whole picture often means moving between screens, metadata, queries, spreadsheets, and tribal knowledge.',
    presentLead: 'Metadata is scattered; understanding it takes work.',
    presentNote: 'Architects need connected metadata, not another screen to search.',
    presentLayout: 'diagnosis',
    presentBody: (
      <div className="slide-diagnosis">
        <SlidePanel label="The real gap" title="Architects need more than another screen.">
          <p>Screens, metadata, queries, spreadsheets, and tribal knowledge become the working map.</p>
          <p className="slide-panel-emphasis">They need a connected view that turns metadata into understanding.</p>
        </SlidePanel>
        <div className="slide-diagnosis-list">
          <SlideLine index="01" title="Fragmented visibility across components" detail="Scattered views" />
          <SlideLine index="02" title="Manual tracing from source to target" detail="Slow discovery" />
          <SlideLine index="03" title="Relationships that are hard to explain" detail="Hidden context" />
          <SlideLine index="04" title="Documentation that falls behind change" detail="Knowledge gaps" />
          <SlideLine index="05" title="Uncertainty about what is confirmed" detail="Review risk" />
        </div>
      </div>
    ),
    body: (
      <div className="story-rows">
        <NumberedRow number="01" title="Fragmented visibility across components" detail="Scattered views" />
        <NumberedRow number="02" title="Manual tracing from source to target" detail="Slow discovery" />
        <NumberedRow number="03" title="Relationships that are hard to explain" detail="Hidden context" />
        <NumberedRow number="04" title="Documentation that falls behind change" detail="Knowledge gaps" />
        <NumberedRow number="05" title="Uncertainty about what is confirmed" detail="Review risk" />
      </div>
    ),
    note: 'Architects need more than another screen. They need a connected view that turns metadata into understanding.',
  },
  {
    id: 'what',
    eyebrow: 'The answer',
    shortTitle: 'What it is',
    title: <>One workbench. <Accent>A connected view.</Accent></>,
    lead: 'DCAT is a local-first, read-only discovery workbench for Salesforce Data Cloud / Data 360 metadata. It helps teams inspect the structure and relationships behind an implementation.',
    presentLead: 'A read-only workbench for connected metadata.',
    presentNote: 'Built for discovery and assessment, not org configuration.',
    presentLayout: 'capabilities',
    presentBody: (
      <div className="slide-capabilities">
        <div className="slide-capability">
          <SlideLabel>01 · Discover</SlideLabel>
          <Icon name="layers" size={22} />
          <h4>See what is there</h4>
          <p>Explore Data Spaces, DLOs, DMOs, streams, mappings, transforms, and available metadata.</p>
        </div>
        <div className="slide-capability">
          <SlideLabel>02 · Understand</SlideLabel>
          <Icon name="graph" size={22} />
          <h4>Connect the pieces</h4>
          <p>Visualize relationships, field mappings, transformations, and end-to-end data lineage.</p>
        </div>
        <div className="slide-capability">
          <SlideLabel>03 · Validate</SlideLabel>
          <Icon name="shield" size={22} />
          <h4>Review with evidence</h4>
          <p>Inspect provenance, confidence, retrieval status, and gaps instead of treating every relationship as fact.</p>
        </div>
      </div>
    ),
    body: (
      <div className="story-grid story-grid-3">
        <StoryCard icon="layers" tag="Discover" title="See what is there">
          Explore Data Spaces, DLOs, DMOs, streams, mappings, transforms, and available metadata.
        </StoryCard>
        <StoryCard icon="graph" tag="Understand" title="Connect the pieces">
          Visualize relationships, field mappings, transformations, and end-to-end data lineage.
        </StoryCard>
        <StoryCard icon="shield" tag="Validate" title="Review with evidence">
          Inspect provenance, confidence, retrieval status, and gaps instead of treating every relationship as fact.
        </StoryCard>
      </div>
    ),
    note: 'Designed for architectural discovery and assessment, not org configuration or data operations.',
  },
  {
    id: 'flow',
    eyebrow: 'The architecture in context',
    shortTitle: 'Flow',
    title: <>Follow the data. <Accent>Understand the model.</Accent></>,
    lead: 'DCAT brings key metadata families into a connected exploration experience.',
    presentLead: 'Bring metadata families into one connected view.',
    presentNote: 'Conceptual flow; available paths depend on the org.',
    presentLayout: 'flow',
    presentBody: (
      <div className="slide-flow">
        <div className="slide-flow-track">
          <SlideStage icon="plug" title="Source systems" detail="Where business data originates" />
          <SlideStage icon="stream" title="Data Streams" detail="Ingestion configuration and source" />
          <SlideStage icon="database" title="DLOs" detail="Data landing objects" />
          <SlideStage icon="route" title="Mappings & transforms" detail="How data is shaped" />
          <SlideStage icon="cube" title="DMOs" detail="Harmonized data model" />
          <SlideStage icon="graph" title="Downstream use" detail="Business and activation context" />
        </div>
        <OutcomeStrip
          title="From isolated metadata to connected architecture."
          detail="ERD + Data Lineage Explorer + Change Impact Analyzer + field-level mapping + transform context + data dictionary."
        />
      </div>
    ),
    body: (
      <>
        <div className="story-pipeline">
          <FlowNode icon="plug" title="Source systems" detail="Where business data originates" />
          <FlowNode icon="stream" title="Data Streams" detail="Ingestion configuration and source" />
          <FlowNode icon="database" title="DLOs" detail="Data landing objects" />
          <FlowNode icon="route" title="Mappings & transforms" detail="How data is shaped" />
          <FlowNode icon="cube" title="DMOs" detail="Harmonized data model" />
          <FlowNode icon="graph" title="Downstream use" detail="Business and activation context" />
        </div>
        <OutcomeStrip
          title="From isolated metadata to connected architecture."
          detail="ERD + Data Lineage Explorer + Change Impact Analyzer + field-level mapping + transform context + data dictionary."
        />
      </>
    ),
    note: 'Conceptual flow for explanation. Exact paths and available metadata depend on the org and supported endpoints.',
  },
  {
    id: 'workflow',
    eyebrow: 'Use case 01 · Architecture discovery',
    shortTitle: 'Workflow',
    title: <>Understand an unfamiliar <Accent>Data Cloud org faster.</Accent></>,
    lead: 'Useful when joining a project, taking over an implementation, preparing an assessment, or reviewing an existing design.',
    presentLead: 'Faster discovery for an unfamiliar org.',
    presentLayout: 'process',
    presentBody: (
      <div className="slide-process">
        <div className="slide-process-list">
          <SlideLine index="01" title="Connect" detail="Use the Salesforce CLI authentication already on the architect’s machine." />
          <SlideLine index="02" title="Inventory" detail="Review available Data Spaces, streams, objects, mappings, and transforms." />
          <SlideLine index="03" title="Explore" detail="Open ERD, Data Lineage Explorer, Change Impact Analyzer, mapping, stream, and transform views." />
          <SlideLine index="04" title="Investigate" detail="Trace dependencies, inspect provenance, and identify partial or unresolved areas." />
          <SlideLine index="05" title="Share" detail="Export diagrams and metadata summaries for reviews and handovers." />
        </div>
        <SlidePanel label="Outcome" title="Less manual reconstruction." tone="success">
          <p>A clearer starting point for technical discovery and architecture conversations.</p>
          <p>Useful when joining a project, taking over an implementation, preparing an assessment, or reviewing an existing design.</p>
          <p className="slide-panel-emphasis">Read-only discovery using metadata already available through the Salesforce CLI.</p>
        </SlidePanel>
      </div>
    ),
    body: (
      <>
        <div className="story-grid story-grid-5">
          <Step number="01" title="Connect">Use the Salesforce CLI authentication already on the architect’s machine.</Step>
          <Step number="02" title="Inventory">Review available Data Spaces, streams, objects, mappings, and transforms.</Step>
          <Step number="03" title="Explore">Open ERD, Data Lineage Explorer, Change Impact Analyzer, mapping, stream, and transform views.</Step>
          <Step number="04" title="Investigate">Trace dependencies, inspect provenance, and identify partial or unresolved areas.</Step>
          <Step number="05" title="Share">Export diagrams and metadata summaries for reviews and handovers.</Step>
        </div>
        <OutcomeStrip
          title="Outcome: less manual reconstruction."
          detail="A clearer starting point for technical discovery and architecture conversations."
        />
      </>
    ),
    presentNote: 'Read-only discovery using metadata already available through the Salesforce CLI.',
  },
  {
    id: 'alignment',
    eyebrow: 'Use case 02 · Business-to-technical alignment',
    shortTitle: 'Alignment',
    title: <>Translate a business need <Accent>into a traceable data path.</Accent></>,
    lead: 'Turn a business request into an inspectable chain of sources, streams, mappings, and model objects.',
    presentLead: 'Turn a business request into a traceable data path.',
    presentNote: 'Paths are inspectable; customer records are not validated.',
    presentLayout: 'alignment',
    presentBody: (
      <div className="slide-alignment">
        <div className="slide-alignment-panels">
          <SlidePanel label="The business asks" tone="brand">
            <blockquote className="slide-quote">“We need a unified customer profile with loyalty tier and latest purchase information.”</blockquote>
            <p>The business cares about the outcome. The architect needs to identify the source data, ingestion path, mappings, model entities, and any gaps.</p>
            <p className="slide-panel-emphasis">Start with the business attribute. Trace it back to evidence.</p>
          </SlidePanel>
          <SlidePanel label="The architect investigates" tone="success">
            <div className="slide-checklist">
              <CheckItem>Which source systems provide loyalty and purchase information?</CheckItem>
              <CheckItem>Which streams and DLOs represent the ingested data?</CheckItem>
              <CheckItem>Which mappings and transforms shape the attributes?</CheckItem>
              <CheckItem>Which DMOs and relationships represent the business concepts?</CheckItem>
              <CheckItem>What is confirmed, derived, partial, or not yet visible?</CheckItem>
            </div>
            <p className="slide-panel-emphasis">Outcome: a shared, inspectable explanation of the data foundation.</p>
          </SlidePanel>
        </div>
        <p className="slide-fineprint">DCAT helps inspect metadata paths; it does not validate individual customer records or guarantee downstream business availability.</p>
      </div>
    ),
    body: (
      <div className="story-grid story-grid-2">
        <div className="story-scenario">
          <p className="story-tag">The business asks</p>
          <blockquote className="story-quote">“We need a unified customer profile with loyalty tier and latest purchase information.”</blockquote>
          <p className="story-card-text">The business cares about the outcome. The architect needs to identify the source data, ingestion path, mappings, model entities, and any gaps.</p>
          <p className="story-scenario-result">Start with the business attribute. Trace it back to evidence.</p>
        </div>
        <div className="story-scenario">
          <p className="story-tag">The architect investigates</p>
          <div className="story-checks">
            <CheckItem>Which source systems provide loyalty and purchase information?</CheckItem>
            <CheckItem>Which streams and DLOs represent the ingested data?</CheckItem>
            <CheckItem>Which mappings and transforms shape the attributes?</CheckItem>
            <CheckItem>Which DMOs and relationships represent the business concepts?</CheckItem>
            <CheckItem>What is confirmed, derived, partial, or not yet visible?</CheckItem>
          </div>
          <p className="story-scenario-result">Outcome: a shared, inspectable explanation of the data foundation.</p>
        </div>
      </div>
    ),
    note: 'DCAT helps inspect metadata paths; it does not validate individual customer records or guarantee downstream business availability.',
  },
  {
    id: 'handover',
    eyebrow: 'Use case 03 · After Hypercare',
    shortTitle: 'Handover',
    title: <>Carry the architecture forward <Accent>after Hypercare.</Accent></>,
    lead: 'When the support period ends, the customer owns the org. DCAT gives the incoming team a read-only way to confirm what was built, answer questions, and review changes without relying on the delivery team’s memory.',
    presentLead: 'Give the incoming team a read-only handover view.',
    presentNote: 'Reads metadata only; runbooks and approvals still matter.',
    presentLayout: 'timeline',
    presentBody: (
      <div className="slide-timeline">
        <div className="slide-timeline-track">
          <div className="slide-timeline-step">
            <SlideLabel>01 · Confirm the handover</SlideLabel>
            <p>Compare the documented design with the metadata actually present before the delivery team steps away.</p>
          </div>
          <div className="slide-timeline-step">
            <SlideLabel>02 · Bring new owners up to speed</SlideLabel>
            <p>Follow a source-to-target path and inspect DLOs, DMOs, mappings, and transforms in one place.</p>
          </div>
          <div className="slide-timeline-step">
            <SlideLabel>03 · Support the org with confidence</SlideLabel>
            <p>Review dependencies before a change, refresh the snapshot as the org evolves, and export diagrams for internal runbooks.</p>
          </div>
        </div>
        <OutcomeStrip
          title="Outcome: the customer team can explain and support its own data architecture."
          detail="Repeatable discovery, grounded evidence, and shareable artifacts beyond the Hypercare window."
        />
        <p className="slide-fineprint">DCAT reads metadata only. It does not replace runbooks, monitoring, or change approvals, and it never shows customer or transaction records.</p>
      </div>
    ),
    body: (
      <>
        <div className="story-grid story-grid-3">
          <Step number="01" title="Confirm the handover">
            Compare the documented design with the metadata actually present before the delivery team steps away.
          </Step>
          <Step number="02" title="Bring new owners up to speed">
            Follow a source-to-target path and inspect DLOs, DMOs, mappings, and transforms in one place.
          </Step>
          <Step number="03" title="Support the org with confidence">
            Review dependencies before a change, refresh the snapshot as the org evolves, and export diagrams for internal runbooks.
          </Step>
        </div>
        <OutcomeStrip
          title="Outcome: the customer team can explain and support its own data architecture."
          detail="Repeatable discovery, grounded evidence, and shareable artifacts beyond the Hypercare window."
        />
      </>
    ),
    note: 'DCAT reads metadata only. It does not replace runbooks, monitoring, or change approvals, and it never shows customer or transaction records.',
  },
  {
    id: 'audiences',
    eyebrow: 'Designed for the people around the data',
    shortTitle: 'Audiences',
    title: <>One architecture view. <Accent>Different team outcomes.</Accent></>,
    lead: 'The same architecture view answers different questions for each role around the data.',
    presentLead: 'One view, different answers for each role.',
    presentNote: 'Outputs help everyone; the workbench is architect-oriented.',
    presentLayout: 'roles',
    presentBody: (
      <div className="slide-roles">
        <SlideLine index="01" title="Architects" detail="Models, relationships, lineage, and implementation structure." />
        <SlideLine index="02" title="Engineers" detail="Mappings, transforms, source paths, and dependencies." />
        <SlideLine index="03" title="Admins" detail="Configured metadata and environment-level visibility." />
        <SlideLine index="04" title="Analysts & Product" detail="Business attributes to technical objects and source context." />
        <SlideLine index="05" title="Delivery leads" detail="Architecture artifacts, handovers, and areas needing attention." />
        <p className="slide-fineprint">Business stakeholders benefit from the outputs and shared explanations; the current workbench remains primarily architect-oriented.</p>
      </div>
    ),
    body: (
      <div className="story-grid story-grid-5">
        <StoryCard tag="Architects" title="Explore the model">Models, relationships, lineage, and implementation structure.</StoryCard>
        <StoryCard tag="Engineers" title="Trace the path">Mappings, transforms, source paths, and dependencies.</StoryCard>
        <StoryCard tag="Admins" title="Understand configuration">Configured metadata and environment-level visibility.</StoryCard>
        <StoryCard tag="Analysts & Product" title="Connect meaning">Business attributes to technical objects and source context.</StoryCard>
        <StoryCard tag="Delivery leads" title="Review delivery">Architecture artifacts, handovers, and areas needing attention.</StoryCard>
      </div>
    ),
    note: 'Business stakeholders benefit from the outputs and shared explanations; the current workbench remains primarily architect-oriented.',
  },
  {
    id: 'trust',
    eyebrow: 'The differentiators',
    shortTitle: 'Trust',
    title: <>Visibility is useful. <Accent>Trust makes it valuable.</Accent></>,
    lead: 'DCAT’s strongest distinction is not simply showing more metadata. It is showing relationships with context, boundaries, and evidence.',
    presentLead: 'Show relationships with context and evidence.',
    presentNote: 'Evidence and boundaries make diagrams honest.',
    presentLayout: 'evidence',
    presentBody: (
      <div className="slide-evidence">
        <div className="slide-evidence-copy">
          <p className="slide-principle">Make the status of every relationship <Accent>visible.</Accent></p>
          <p>Architectural diagrams should not make inferred information look authoritative. DCAT separates what the org returned from what the toolkit derived and what could not be resolved.</p>
          <p className="slide-panel-emphasis">Architecture with evidence, not guesswork: clearer reviews, more honest diagrams, and better technical conversations.</p>
        </div>
        <div className="slide-evidence-legend">
          <LegendRow line="line-solid" title="Confirmed by metadata" detail="Grounded in retrieved source metadata" />
          <LegendRow line="line-dashed" title="Derived by DCAT" detail="Explicitly inferred from available metadata" />
          <LegendRow line="line-dotted" title="Unresolved reference" detail="Referenced but missing from the snapshot" />
        </div>
      </div>
    ),
    body: (
      <div className="story-grid story-grid-2">
        <div>
          <p className="story-principle">Make the status of every relationship <Accent>visible.</Accent></p>
          <p className="story-card-text">Architectural diagrams should not make inferred information look authoritative. DCAT separates what the org returned from what the toolkit derived and what could not be resolved.</p>
        </div>
        <div className="story-legend">
          <LegendRow line="line-solid" title="Confirmed by metadata" detail="Grounded in retrieved source metadata" />
          <LegendRow line="line-dashed" title="Derived by DCAT" detail="Explicitly inferred from available metadata" />
          <LegendRow line="line-dotted" title="Unresolved reference" detail="Referenced but missing from the snapshot" />
        </div>
      </div>
    ),
    note: 'Architecture with evidence, not guesswork: clearer reviews, more honest diagrams, and better technical conversations.',
  },
  {
    id: 'boundaries',
    eyebrow: 'Trust by design',
    shortTitle: 'Boundaries',
    title: <>Useful visibility. <Accent>Careful boundaries.</Accent></>,
    lead: 'DCAT is designed to inspect metadata without becoming another system that operates on the Salesforce org.',
    presentLead: 'Inspect metadata without operating on the org.',
    presentNote: 'Metadata can be sensitive; this is not a security review.',
    presentLayout: 'guardrails',
    presentBody: (
      <div className="slide-guardrails">
        <div className="slide-guardrails-list">
          <div className="slide-guardrail">
            <Icon name="shield" size={20} />
            <div>
              <strong>Read-only discovery</strong>
              <p>Uses allowlisted, read-only Salesforce CLI commands. It does not create, update, delete, deploy, activate, ingest, or refresh org data.</p>
            </div>
          </div>
          <div className="slide-guardrail">
            <Icon name="lock" size={20} />
            <div>
              <strong>CLI-owned authentication</strong>
              <p>Salesforce CLI handles login. DCAT does not ask for passwords, tokens, auth URLs, or client secrets.</p>
            </div>
          </div>
          <div className="slide-guardrail">
            <Icon name="database" size={20} />
            <div>
              <strong>Metadata, not customer records</strong>
              <p>It does not query or display customer or transaction records. Exports are local and user-initiated.</p>
            </div>
          </div>
        </div>
        <SlidePanel label="How it runs">
          <div className="slide-mode">
            <strong>Local mode</strong>
            <p>Run on your computer with Salesforce CLI authentication on that machine.</p>
          </div>
          <div className="slide-mode">
            <strong>Hosted mode</strong>
            <p>Hosted UI plus a local outbound bridge connects to CLI-backed discovery without exposing an inbound port.</p>
          </div>
          <p className="slide-fineprint">Security-conscious design does not replace an organization’s own security, privacy, or risk review. Metadata can still reveal sensitive architecture details.</p>
        </SlidePanel>
      </div>
    ),
    body: (
      <>
        <div className="story-grid story-grid-3">
          <StoryCard icon="shield" title="Read-only discovery">
            Uses allowlisted, read-only Salesforce CLI commands. It does not create, update, delete, deploy, activate, ingest, or refresh org data.
          </StoryCard>
          <StoryCard icon="lock" title="CLI-owned authentication">
            Salesforce CLI handles login. DCAT does not ask for passwords, tokens, auth URLs, or client secrets.
          </StoryCard>
          <StoryCard icon="database" title="Metadata, not customer records">
            It does not query or display customer or transaction records. Exports are local and user-initiated.
          </StoryCard>
        </div>
        <div className="story-grid story-grid-2">
          <StoryCard tag="Local mode" title="Run on your computer">
            Use the local workbench with Salesforce CLI authentication on that machine.
          </StoryCard>
          <StoryCard tag="Hosted mode" title="Hosted UI + local bridge">
            The local outbound bridge connects the hosted experience to CLI-backed discovery without exposing an inbound port.
          </StoryCard>
        </div>
      </>
    ),
    note: 'Security-conscious design does not replace an organization’s own security, privacy, or risk review. Metadata can still reveal sensitive architecture details.',
  },
  {
    id: 'value',
    eyebrow: 'Why it matters to delivery',
    shortTitle: 'Value',
    title: <>Less time piecing things together. <Accent>More time making decisions.</Accent></>,
    lead: 'DCAT creates a practical starting point for discovery, investigation, architecture reviews, and knowledge transfer.',
    presentLead: 'A starting point for discovery, reviews, and handovers.',
    presentNote: 'Suggested measures, not claimed performance results.',
    presentLayout: 'measures',
    presentBody: (
      <div className="slide-measures">
        <SlideLine index="01" title="Time to understand an unfamiliar org" detail="Efficiency" />
        <SlideLine index="02" title="Time to trace a source-to-target field" detail="Efficiency" />
        <SlideLine index="03" title="Time to produce architecture artifacts" detail="Productivity" />
        <SlideLine index="04" title="Dependencies and gaps surfaced" detail="Risk insight" />
        <SlideLine index="05" title="Handover and review readiness" detail="Continuity" />
        <p className="slide-fineprint">These are recommended success measures, not claimed or measured DCAT performance results.</p>
      </div>
    ),
    body: (
      <div className="story-rows">
        <NumberedRow number="01" title="Time to understand an unfamiliar org" detail="Efficiency" />
        <NumberedRow number="02" title="Time to trace a source-to-target field" detail="Efficiency" />
        <NumberedRow number="03" title="Time to produce architecture artifacts" detail="Productivity" />
        <NumberedRow number="04" title="Dependencies and gaps surfaced" detail="Risk insight" />
        <NumberedRow number="05" title="Handover and review readiness" detail="Continuity" />
      </div>
    ),
    note: 'These are recommended success measures, not claimed or measured DCAT performance results.',
  },
  {
    id: 'roadmap',
    eyebrow: 'A path to deeper differentiation',
    shortTitle: 'Roadmap',
    title: <>From discovery <Accent>to architecture intelligence.</Accent></>,
    lead: 'Build on the current metadata foundation. Prioritize capabilities that turn visibility into better decisions.',
    presentLead: 'Turn visibility into better decisions.',
    presentNote: 'Concepts are proposals, not shipped features.',
    presentLayout: 'roadmap',
    presentBody: (
      <div className="slide-roadmap-phases">
        <SlidePhase
          kicker="Foundation · Current capabilities"
          title="Discover & explain"
          description="Make the existing workbench dependable, coherent, and easy to use."
          current
          items={[
            { title: 'Inventory & explorers', detail: 'Data Spaces, DLOs, DMOs, streams, mappings, transforms.' },
            { title: 'ERD & lineage', detail: 'Relationship visualization, tracing, evidence and gaps.' },
            { title: 'Change Impact Analyzer', detail: 'Review grounded upstream and downstream dependencies before a change.' },
            { title: 'Dictionary & exports', detail: 'Field reference and reusable architecture artifacts.' },
          ]}
        />
        <SlidePhase
          kicker="Next · High-value extensions"
          title="Compare & assess"
          description="Help teams answer what changed and what might be affected."
          items={[
            { title: 'Environment comparison', detail: 'Compare metadata snapshots across Dev, UAT, and Production.' },
            { title: 'Architecture health checks', detail: 'Flag reviewable gaps, inconsistencies, and unresolved references.' },
            { title: 'Guided change reviews', detail: 'Turn dependency findings into review checklists.' },
          ]}
        />
        <SlidePhase
          kicker="Later · Broader adoption"
          title="Align & communicate"
          description="Make architecture knowledge easier to share across teams."
          items={[
            { title: 'Business data dictionary', detail: 'Connect technical fields to business meaning and ownership.' },
            { title: 'Requirements traceability', detail: 'Link business needs to data assets and implementation evidence.' },
            { title: 'Architecture report generator', detail: 'Produce structured review and handover documentation.' },
          ]}
        />
      </div>
    ),
    body: (
      <div className="story-grid story-grid-3">
        <RoadmapColumn
          kicker="Foundation · Current capabilities"
          title="Discover & explain"
          description="Make the existing workbench dependable, coherent, and easy to use."
          current
          items={[
            { title: 'Inventory & explorers', detail: 'Data Spaces, DLOs, DMOs, streams, mappings, transforms.' },
            { title: 'ERD & lineage', detail: 'Relationship visualization, tracing, evidence and gaps.' },
            { title: 'Change Impact Analyzer', detail: 'Review grounded upstream and downstream dependencies before a change.' },
            { title: 'Dictionary & exports', detail: 'Field reference and reusable architecture artifacts.' },
          ]}
        />
        <RoadmapColumn
          kicker="Next · High-value extensions"
          title="Compare & assess"
          description="Help teams answer what changed and what might be affected."
          items={[
            { title: 'Environment comparison', detail: 'Compare metadata snapshots across Dev, UAT, and Production.' },
            { title: 'Architecture health checks', detail: 'Flag reviewable gaps, inconsistencies, and unresolved references.' },
            { title: 'Guided change reviews', detail: 'Turn dependency findings into review checklists.' },
          ]}
        />
        <RoadmapColumn
          kicker="Later · Broader adoption"
          title="Align & communicate"
          description="Make architecture knowledge easier to share across teams."
          items={[
            { title: 'Business data dictionary', detail: 'Connect technical fields to business meaning and ownership.' },
            { title: 'Requirements traceability', detail: 'Link business needs to data assets and implementation evidence.' },
            { title: 'Architecture report generator', detail: 'Produce structured review and handover documentation.' },
          ]}
        />
      </div>
    ),
    note: 'Roadmap concepts are proposals, not claims about features already implemented.',
  },
  {
    id: 'demo',
    eyebrow: 'A compelling product walkthrough',
    shortTitle: 'Demo',
    title: <>Lead with a question. <Accent>Let DCAT answer it.</Accent></>,
    lead: 'Rather than touring every menu, anchor the demo in the problems architects and delivery teams actually face.',
    presentLead: 'Anchor the demo in real architect problems.',
    presentNote: 'Illustrative layout; counts and indicators are sample values.',
    presentLayout: 'demo',
    presentBody: (
      <div className="slide-demo">
        <div className="slide-demo-questions">
          <SlideLabel>Questions that earn the demo</SlideLabel>
          <div className="story-question">What does this org contain?</div>
          <div className="story-question">Where does this field come from?</div>
          <div className="story-question">How are these objects related?</div>
          <div className="story-question">What do we know, and what is inferred?</div>
          <div className="story-question">What can we share with the project team?</div>
        </div>
        <div className="slide-demo-screen">
          <MockScreen />
          <p className="slide-fineprint">Illustrative layout only. Counts and visual indicators are sample/demo values, not a live org.</p>
        </div>
      </div>
    ),
    body: (
      <div className="story-grid story-grid-demo">
        <div className="story-rows">
          <div className="story-question">What does this org contain?</div>
          <div className="story-question">Where does this field come from?</div>
          <div className="story-question">How are these objects related?</div>
          <div className="story-question">What do we know, and what is inferred?</div>
          <div className="story-question">What can we share with the project team?</div>
        </div>
        <div>
          <MockScreen />
          <Note>Illustrative layout only. Counts and visual indicators are sample/demo values, not a live org.</Note>
        </div>
      </div>
    ),
  },
  {
    id: 'takeaway',
    eyebrow: 'The DCAT opportunity',
    shortTitle: 'Takeaway',
    title: <>Don’t just see the data. <Accent>Understand the architecture.</Accent></>,
    lead: 'DCAT can become the architect’s workbench for discovering what exists, understanding how it connects, and making better-informed decisions.',
    presentLead: 'Discover what exists, understand how it connects.',
    presentNote: 'Created in a personal capacity; not an official Salesforce product.',
    presentLayout: 'takeaway',
    presentBody: (
      <div className="slide-takeaway">
        <div className="slide-takeaway-copy">
          <p className="slide-takeaway-statement">Don’t just see the data. <Accent>Understand the architecture.</Accent></p>
          <Pills items={[
            { label: 'Discover', tone: 'brand' },
            { label: 'Understand', tone: 'info' },
            { label: 'Validate', tone: 'violet' },
            { label: 'Share', tone: 'success' },
          ]} />
        </div>
        <div className="story-links">
          <a href={WORKBENCH_URL} target="_blank" rel="noopener noreferrer" aria-label="Open the DCAT workbench (opens in a new tab)">
            <span><small>Try the workbench</small><strong>sfdcat.pages.dev</strong></span>
            <Icon name="arrowRight" size={18} />
          </a>
          <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label="Open the DCAT GitHub repository (opens in a new tab)">
            <span><small>Explore the project</small><strong>GitHub repository</strong></span>
            <Icon name="arrowRight" size={18} />
          </a>
        </div>
      </div>
    ),
    body: (
      <div className="story-grid story-grid-2">
        <div>
          <Pills items={[
            { label: 'Discover', tone: 'brand' },
            { label: 'Understand', tone: 'info' },
            { label: 'Validate', tone: 'violet' },
            { label: 'Share', tone: 'success' },
          ]} />
          <p className="story-card-text">Created in a personal capacity. DCAT is not an official Salesforce product.</p>
        </div>
        <div className="story-links">
          <a href={WORKBENCH_URL} target="_blank" rel="noopener noreferrer" aria-label="Open the DCAT workbench (opens in a new tab)">
            <span><small>Try the workbench</small><strong>sfdcat.pages.dev</strong></span>
            <Icon name="arrowRight" size={18} />
          </a>
          <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label="Open the DCAT GitHub repository (opens in a new tab)">
            <span><small>Explore the project</small><strong>GitHub repository</strong></span>
            <Icon name="arrowRight" size={18} />
          </a>
        </div>
      </div>
    ),
    note: 'A local-first, read-only discovery workbench for Salesforce Data Cloud / Data 360.',
  },
];

function ChapterView({ chapter, mode }: { chapter: Chapter; mode: 'story' | 'present' }) {
  const headingId = `${mode}-chapter-${chapter.id}`;
  const isPresent = mode === 'present';
  const lead = isPresent ? (chapter.presentLead ?? chapter.lead) : chapter.lead;
  const note = isPresent ? (chapter.presentNote ?? chapter.note) : chapter.note;
  const body = isPresent ? (chapter.presentBody ?? chapter.body) : chapter.body;
  return (
    <section
      className={`story-chapter ${mode === 'story' ? 'story-chapter-scroll' : ''} ${isPresent && chapter.presentLayout ? `present-layout-${chapter.presentLayout}` : ''}`}
      data-chapter={chapter.id}
      data-mode={mode}
      aria-labelledby={headingId}
    >
      <div className="story-chapter-head">
        <p className="story-eyebrow">{chapter.eyebrow}</p>
        <h3 id={headingId} className="story-title">{chapter.title}</h3>
        {lead ? <p className="story-lead">{lead}</p> : null}
      </div>
      <div className="story-body">{body}</div>
      {note ? <Note>{note}</Note> : null}
    </section>
  );
}

export function AboutPage({ onNavigate }: AboutPageProps) {
  const deckRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef<number | null>(null);
  const restoreFrame = useRef<number | null>(null);
  const wasFullscreen = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const [notice, setNotice] = useState('');

  const goToSlide = useCallback((index: number) => {
    setSlideIndex(Math.max(0, Math.min(chapters.length - 1, index)));
  }, []);

  const stepSlide = useCallback((delta: number) => {
    setSlideIndex((current) => Math.max(0, Math.min(chapters.length - 1, current + delta)));
  }, []);

  useEffect(() => {
    const syncFullscreen = () => {
      const active = document.fullscreenElement === deckRef.current;
      setIsFullscreen(active);
      if (wasFullscreen.current && !active) {
        document.getElementById('about-present-button')?.focus({ preventScroll: true });
      }
      wasFullscreen.current = active;
    };
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  useEffect(() => {
    if (!isFullscreen) return;
    deckRef.current?.focus({ preventScroll: true });
  }, [isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [isFullscreen]);

  // The deck frame is fixed; fit each chapter's natural height into it instead
  // of letting a dense slide scroll behind a title that never moves.
  useLayoutEffect(() => {
    if (!isFullscreen) return;
    const slide = slideRef.current;
    if (!slide) return;
    let frame = 0;

    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const chapter = slide.querySelector<HTMLElement>('.story-chapter');
        if (!chapter) return;
        slide.style.setProperty('--slide-fit', '1');
        slide.classList.add('is-measuring');
        const naturalHeight = chapter.getBoundingClientRect().height;
        slide.classList.remove('is-measuring');
        const availableHeight = slide.clientHeight;
        const fit = Math.max(0.6, Math.min(1, availableHeight / Math.max(naturalHeight, 1)));
        slide.style.setProperty('--slide-fit', fit.toFixed(4));
      });
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(slide);
    window.addEventListener('resize', measure);
    void document.fonts?.ready.then(measure).catch(() => undefined);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [isFullscreen, slideIndex]);

  useEffect(() => {
    const restoreChapter = () => {
      if (document.fullscreenElement) return;
      const prefix = '#story-scroll-';
      if (!window.location.hash.startsWith(prefix)) return;
      const id = window.location.hash.slice(prefix.length);
      if (!chapters.some((chapter) => chapter.id === id)) return;
      if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current);
      restoreFrame.current = requestAnimationFrame(() => {
        restoreFrame.current = null;
        if (document.fullscreenElement) return;
        document.getElementById(`story-scroll-${id}`)?.scrollIntoView({ behavior: 'instant', block: 'start' });
      });
    };
    restoreChapter();
    window.addEventListener('popstate', restoreChapter);
    return () => {
      window.removeEventListener('popstate', restoreChapter);
      if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        if ((target.tagName === 'BUTTON' || target.tagName === 'A') && event.key === ' ') return;
      }
      if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
        event.preventDefault();
        stepSlide(1);
      } else if (['ArrowLeft', 'PageUp'].includes(event.key)) {
        event.preventDefault();
        stepSlide(-1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        goToSlide(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        goToSlide(chapters.length - 1);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [goToSlide, isFullscreen, stepSlide]);

  const startPresenting = async () => {
    setNotice('');
    setSlideIndex(0);
    try {
      await deckRef.current?.requestFullscreen();
    } catch {
      setNotice('Full screen is unavailable in this browser.');
    }
  };

  const openChapter = (id: string) => {
    document.getElementById(`story-scroll-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const url = new URL(window.location.href);
    url.hash = `story-scroll-${id}`;
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  };

  const stopPresenting = async () => {
    try {
      await document.exitFullscreen();
    } catch {
      /* The browser may already have exited full screen. */
    }
    document.getElementById('about-present-button')?.focus({ preventScroll: true });
  };

  const activeChapter = chapters[slideIndex];

  return (
    <div className="space-y-5">
      <PageIntro
        title="About DCAT"
        description="Scroll through the story below, or open the full-screen deck."
        meta={<Badge tone="brand" dot>Read-only · Local-first</Badge>}
        actions={
          <Button
            id="about-present-button"
            variant="secondary"
            icon={<Icon name="presentation" size={17} />}
            onClick={() => void startPresenting()}
          >
            Present
          </Button>
        }
      />

      {notice ? (
        <p role="status" className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-2.5 text-sm text-warning">
          {notice}
        </p>
      ) : null}

      <Panel className="p-4 sm:p-5">
        <p className="label-xs mb-3">Jump to a chapter</p>
        <nav className="chapter-index" aria-label="Chapters">
          {chapters.map((chapter, index) => (
            <button
              key={chapter.id}
              type="button"
              onClick={() => openChapter(chapter.id)}
              className="chapter-index-link"
            >
              <span>{String(index + 1).padStart(2, '0')}</span>{' '}
              {chapter.shortTitle}
            </button>
          ))}
        </nav>
      </Panel>

      <div className="story-flow">
        {chapters.map((chapter) => (
          <div key={chapter.id} id={`story-scroll-${chapter.id}`} className="scroll-mt-20">
            <ChapterView chapter={chapter} mode="story" />
          </div>
        ))}
      </div>

      <Panel className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div>
          <p className="text-sm font-medium text-ink">Keep exploring DCAT</p>
          <p className="mt-0.5 text-xs text-ink-soft">Open the workbench, or read the docs for setup and safety details.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => onNavigate('dashboard')} icon={<Icon name="dashboard" size={16} />}>
            Open Dashboard
          </Button>
          <Button variant="quiet" onClick={() => onNavigate('help')} icon={<Icon name="info" size={16} />}>
            Read the docs
          </Button>
        </div>
      </Panel>

      <div
        ref={deckRef}
        className="deck-shell"
        role="region"
        aria-roledescription="presentation"
        aria-label="DCAT presentation"
        tabIndex={-1}
        aria-hidden={!isFullscreen}
        inert={!isFullscreen}
        onTouchStart={(event) => { touchStartX.current = event.changedTouches[0].screenX; }}
        onTouchCancel={() => { touchStartX.current = null; }}
        onTouchEnd={(event) => {
          if (touchStartX.current === null) return;
          const delta = event.changedTouches[0].screenX - touchStartX.current;
          if (Math.abs(delta) > 55) stepSlide(delta < 0 ? 1 : -1);
          touchStartX.current = null;
        }}
      >
        <div className="deck-topbar">
          <div className="deck-brand">
            <span className="deck-brand-mark" aria-hidden="true"><Icon name="presentation" size={20} /></span>
            <span>
              <span className="deck-brand-name">DCAT</span>
              <span className="deck-brand-sub">Data Cloud Architect Toolkit</span>
            </span>
          </div>
          <div className="deck-top-meta">
            <span className="deck-status">Architectural discovery workbench</span>
            <a className="deck-top-link" href={WORKBENCH_URL} target="_blank" rel="noopener noreferrer">
              Open DCAT ↗
            </a>
          </div>
        </div>

        <div className="deck-stage">
          {activeChapter ? (
            <div className="deck-frame">
              <div className="deck-slide is-active" key={activeChapter.id} ref={slideRef}>
                <ChapterView chapter={activeChapter} mode="present" />
              </div>
            </div>
          ) : null}
        </div>

        <div className="deck-controls">
          <div className="deck-control-left">
            <span className="deck-counter" aria-live="polite" aria-atomic="true">
              <strong>{String(slideIndex + 1).padStart(2, '0')}</strong> / {String(chapters.length).padStart(2, '0')}
            </span>
            <div className="deck-progress" aria-hidden="true">
              <span style={{ width: `${((slideIndex + 1) / chapters.length) * 100}%` }} />
            </div>
          </div>
          <div className="deck-control-right">
            <span className="deck-hint"><span className="key">←</span><span className="key">→</span> to navigate · Esc to exit</span>
            <span className="deck-current-title">{activeChapter.shortTitle}</span>
            <button type="button" className="deck-icon-btn" onClick={() => void stopPresenting()} aria-label="Exit presentation" title="Exit presentation (Esc)">
              <Icon name="close" size={18} />
            </button>
            <button type="button" className="deck-icon-btn" onClick={() => stepSlide(-1)} disabled={slideIndex === 0} aria-label="Previous slide">
              <Icon name="arrowRight" size={18} className="rotate-180" />
            </button>
            <button type="button" className="deck-icon-btn" onClick={() => stepSlide(1)} disabled={slideIndex === chapters.length - 1} aria-label="Next slide">
              <Icon name="arrowRight" size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
