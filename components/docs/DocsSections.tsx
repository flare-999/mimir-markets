import type { ReactNode } from 'react';

export interface DocsSectionProps {
  id?: string;
  title?: string;
  children?: ReactNode;
}

function DocsSection({ id, title, children }: DocsSectionProps) {
  return (
    <section id={id} className="scroll-mt-24 space-y-4">
      {title ? <h2 className="text-2xl font-semibold tracking-tight">{title}</h2> : null}
      {children}
    </section>
  );
}

export function IntroductionSection() {
  return (
    <DocsSection id="introduction" title="Introduction">
      <p className="text-muted-foreground">
        Welcome to the documentation. This guide covers installation, configuration,
        and deployment of the application.
      </p>
    </DocsSection>
  );
}

export function InstallationSection() {
  return (
    <DocsSection id="installation" title="Installation">
      <p className="text-muted-foreground">
        Install dependencies and start the development server to begin working with the
        project.
      </p>
    </DocsSection>
  );
}

export function QuickStartSection() {
  return (
    <DocsSection id="quick-start" title="Quick Start">
      <p className="text-muted-foreground">
        Follow the steps below to get a minimal application running locally.
      </p>
    </DocsSection>
  );
}

export function ConfigurationSection() {
  return (
    <DocsSection id="configuration" title="Configuration">
      <p className="text-muted-foreground">
        Configure your environment variables and application settings.
      </p>
    </DocsSection>
  );
}

export function AuthenticationSection() {
  return (
    <DocsSection id="authentication" title="Authentication">
      <p className="text-muted-foreground">
        Set up authentication providers and session handling for your app.
      </p>
    </DocsSection>
  );
}

export function DatabaseSection() {
  return (
    <DocsSection id="database" title="Database">
      <p className="text-muted-foreground">
        Connect to your database and run migrations to keep your schema in sync.
      </p>
    </DocsSection>
  );
}

export function ApiRoutesSection() {
  return (
    <DocsSection id="api-routes" title="API Routes">
      <p className="text-muted-foreground">
        Define server endpoints and handle requests with the built-in router.
      </p>
    </DocsSection>
  );
}

export function ComponentsSection() {
  return (
    <DocsSection id="components" title="Components">
      <p className="text-muted-foreground">
        Learn how to build and compose reusable UI components.
      </p>
    </DocsSection>
  );
}

export function ThemingSection() {
  return (
    <DocsSection id="theming" title="Theming">
      <p className="text-muted-foreground">
        Customize colors, typography, and layout to match your brand.
      </p>
    </DocsSection>
  );
}

export function DeploymentSection() {
  return (
    <DocsSection id="deployment" title="Deployment">
      <p className="text-muted-foreground">
        Deploy the application to your preferred hosting provider.
      </p>
    </DocsSection>
  );
}

export function TroubleshootingSection() {
  return (
    <DocsSection id="troubleshooting" title="Troubleshooting">
      <p className="text-muted-foreground">
        Find solutions to common issues encountered during setup and deployment.
      </p>
    </DocsSection>
  );
}

export function FaqSection() {
  return (
    <DocsSection id="faq" title="FAQ">
      <p className="text-muted-foreground">
        Answers to frequently asked questions about the project.
      </p>
    </DocsSection>
  );
}
