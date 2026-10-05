import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { PlanSpec, SpecItem } from '../lib/plan';

const SECTION_IDS = ['overview', 'outcomes', 'scope', 'flows', 'requirements'];

export default function ProductSpecReader({
  spec,
  uncovered,
}: {
  spec: PlanSpec;
  uncovered: SpecItem[];
}) {
  const [open, setOpen] = useState<string[]>(['overview']);
  const id = useId();
  const missing = new Set(uncovered.map((item) => item.id));
  const allOpen = open.length === SECTION_IDS.length;

  const section = (
    key: string,
    title: string,
    description: string,
    children: ReactNode,
    items: SpecItem[] = []
  ) => {
    const expanded = open.includes(key);
    const count = items.filter((item) => missing.has(item.id)).length;
    return (
      <section className="border-t border-line">
        <h3>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`${id}-${key}`}
            onClick={() =>
              setOpen((prev) => (expanded ? prev.filter((item) => item !== key) : [...prev, key]))
            }
            className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-paper sm:px-6"
          >
            <span aria-hidden="true" className="w-4 shrink-0 text-muted">
              {expanded ? '−' : '+'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">{title}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">{description}</span>
            </span>
            {count > 0 && (
              <span className="shrink-0 rounded-full bg-warn-bg px-2.5 py-1 text-xs text-warn-text">
                {count} uncovered
              </span>
            )}
          </button>
        </h3>
        <div id={`${id}-${key}`} hidden={!expanded} className="px-5 pb-6 sm:pl-14 sm:pr-6">
          <div className="max-w-[72ch] space-y-6 text-[14px] leading-7 text-body">{children}</div>
        </div>
      </section>
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 sm:px-6">
        <div>
          <h2 className="text-base font-semibold">Product spec</h2>
          <p className="mt-1 text-xs text-muted">
            Start with the overview, then open a section to review the details.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary h-8 px-3"
          onClick={() => setOpen(allOpen ? [] : SECTION_IDS)}
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      {section(
        'overview',
        'Overview',
        'The problem and the proposed solution',
        <>
          <TextBlock title="The problem">{spec.overview.problem}</TextBlock>
          <TextBlock title="The solution">{spec.overview.summary}</TextBlock>
        </>
      )}
      {section(
        'outcomes',
        'Audience & success',
        `Who this helps · ${spec.overview.successMetrics.length} success metrics`,
        <>
          <TextBlock title="Who it is for">{spec.overview.targetUsers}</TextBlock>
          <div>
            <h4 className="mb-2 font-medium text-ink">How we will measure success</h4>
            {spec.overview.successMetrics.length ? (
              <ul className="list-disc space-y-3 pl-5 marker:text-muted">
                {spec.overview.successMetrics.map((metric, index) => (
                  <li key={index} className="pl-1">
                    {metric}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">No success metrics defined yet.</p>
            )}
          </div>
        </>
      )}
      {section(
        'scope',
        'Scope',
        `${spec.scope.inScope.length} included · ${spec.scope.outOfScope.length} excluded`,
        <>
          <SpecItems title="In scope" items={spec.scope.inScope} missing={missing} />
          <SpecItems title="Out of scope" items={spec.scope.outOfScope} />
        </>,
        spec.scope.inScope
      )}
      {section(
        'flows',
        'User flows',
        `${spec.flows.length} flows to review`,
        <SpecItems title="User flows" items={spec.flows} missing={missing} numbered />,
        spec.flows
      )}
      {section(
        'requirements',
        'Requirements',
        `${spec.requirements.functional.length} functional · ${spec.requirements.nonFunctional.length} non-functional`,
        <>
          <SpecItems
            title="What it must do"
            items={spec.requirements.functional}
            missing={missing}
          />
          <SpecItems
            title="How it must behave"
            items={spec.requirements.nonFunctional}
            missing={missing}
          />
        </>,
        [...spec.requirements.functional, ...spec.requirements.nonFunctional]
      )}
    </>
  );
}

function TextBlock({ title, children }: { title: string; children: string }) {
  return (
    <div>
      <h4 className="mb-2 font-medium text-ink">{title}</h4>
      <p className="whitespace-pre-line">{children}</p>
    </div>
  );
}

function SpecItems({
  title,
  items,
  missing,
  numbered,
}: {
  title: string;
  items: SpecItem[];
  missing?: Set<string>;
  numbered?: boolean;
}) {
  const List = numbered ? 'ol' : 'ul';
  return (
    <div>
      <h4 className="mb-3 font-medium text-ink">{title}</h4>
      {items.length ? (
        <List className={`space-y-3 ${numbered ? 'list-decimal pl-5 marker:text-muted' : ''}`}>
          {items.map((item) => (
            <li key={item.id} className={numbered ? 'pl-1' : 'border-l-2 border-line pl-4'}>
              <p className="whitespace-pre-line">{item.text}</p>
              {missing && (
                <span
                  className={`mt-1 inline-block text-xs ${missing.has(item.id) ? 'text-warn-text' : 'text-go'}`}
                >
                  {missing.has(item.id) ? 'No story covers this yet' : 'Covered by a story'}
                </span>
              )}
            </li>
          ))}
        </List>
      ) : (
        <p className="text-muted">None specified.</p>
      )}
    </div>
  );
}
