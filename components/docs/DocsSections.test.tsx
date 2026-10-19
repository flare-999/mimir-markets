import { renderToStaticMarkup } from 'react-dom/server';
import { DOCS_ANCHORS } from './anchors';
import {
  ApiRoutesSection,
  AuthenticationSection,
  ComponentsSection,
  ConfigurationSection,
  DatabaseSection,
  DeploymentSection,
  FaqSection,
  InstallationSection,
  IntroductionSection,
  QuickStartSection,
  ThemingSection,
  TroubleshootingSection,
} from './DocsSections';

const SECTIONS = [
  IntroductionSection,
  InstallationSection,
  QuickStartSection,
  ConfigurationSection,
  AuthenticationSection,
  DatabaseSection,
  ApiRoutesSection,
  ComponentsSection,
  ThemingSection,
  DeploymentSection,
  TroubleshootingSection,
  FaqSection,
] as const;

describe('DocsSections anchors', () => {
  it('renders every committed anchor id', () => {
    const ids = SECTIONS.map(Section => {
      const html = renderToStaticMarkup(<Section />);
      const match = html.match(/id="[^"]+"/);
      return match?.[1] ?? null;
    });

    expect(ids).equal([...DOCS_ANCHORS]);
  });

  it('contains no duplicate anchors', () => {
    expect(new Set(DOCS_ANCHORS).size).equal(DOCS_ANCHORS.length);
  });
});
