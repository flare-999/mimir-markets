'use client';

import { useEffect, useState } from 'react';
import { DOCS_ANCHORS, DOCS_SECTION_TITLES, type DocsAnchor } from './anchors';

export function DocsToc() {
  const [activeId, setActiveId] = useState<DocsAnchor | null>(null);

  useEffect(() => {
    const elements = DOCS_ANCHORS.map(id => document.getElementById(id)).filter(
      (e): e is HTMLElement => e !== null,
    );

    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.filter(entry => entry.isIntersecting);
        if (visible.length === 0) return;
        const top = visible.reduce((a, b) =>
          a.boundingClientRect.top < b.boundingClientRect.top ? a : b,
        );
        const id = top.target.getAttribute('id');
        if (id) setActiveId(id as DocsAnchor);
      },
      { rootMargin: '-10% 0%s -70% 0%s', threshold: [0] },
    );

    elements.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <nav aria-label="Documentation" className="hidden lg:block">
      <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        On this page
      </p>
      <ul className="space-y-1 border-l text-sm">
        {DOCS_ANCHORS.map(id => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={
                'block border-l transition-colors py-1 pl-4 --ml-px ' +
                (activeId === id
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground')
              }
            >
              {DOCS_SECTION_TITLES[id]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
