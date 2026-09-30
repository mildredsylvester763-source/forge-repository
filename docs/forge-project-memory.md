# FORGE Project Memory

_Last updated: 2026-09-30_

## Product direction

FORGE is intended to become a standalone AI creation and operating environment. It is not an admin dashboard, generic SaaS dashboard, chatbot wrapper, or clone of GitHub, Vercel, Figma, Linear, or Replit.

The core philosophy is:

> Open creation. Controlled execution. Traceable actions.

FORGE is intended to build, improve, host, deploy, and operate software, including FORGE itself. The long-term system may create and coordinate specialized Digital Persons, each with focused capabilities, personality, memory, tools, permissions, evaluation, and improvement within a defined domain. Digital Persons are a future product area and are not yet implemented.

## Current scope

The current repository is a **visual-only prototype**. Its purpose is to establish the visual language, information architecture, responsive behavior, and interaction states before backend implementation.

The visual layer must not invent real user activity. Atlas examples such as Aerialis Prime, active agents, builds, incidents, infrastructure metrics, and marketplace signals are reference-state content. They demonstrate the mature operating environment and are not claims about actual connected data.

## Visual authority

The supplied Forge references define a dense technical operating environment with:

- Dark mineral graphite surfaces
- Deep teal and desaturated green secondary surfaces
- Restrained copper and amber accents
- Warm off-white typography
- Technical metadata and selective monospace
- Fine hairline separators
- Rails, panels, context strips, compact modules, and information bands
- Precise hierarchy rather than generic card stacking
- Responsive desktop, tablet, and phone transformations

The first visual state must not pretend that a new user is already building a turbine or running an active project. Neutral initialization and workspace-entry states remain important, while populated atlas states may be shown as explicit visual reference states.

One image prompt represents one intended Forge visual surface or visual reference. Future prompts should be implemented directly as dense UI surfaces in the established system, without replacing complex references with tiny placeholders.

## Completed visual foundation

The current prototype includes the supplied reference-state direction:

- Populated Forge operating console
- Connected project graph
- Active agents and ongoing builds
- Attention, incident, failure, approval, and critical-change panels
- Activity stream
- Active projects and agents
- Infrastructure health
- Marketplace signals
- Expanded and collapsed desktop navigation
- Nested project navigation
- Selected and hover navigation states
- Mobile navigation drawer
- Responsive surface previews
- Persistent command bar
- Visual-only command and decision interactions
- Keyboard shortcut foundation

This is not the eventual 150-plus-screen Forge system. Future visual prompts will extend it screen by screen.

## Repository and hosting decisions

GitHub is currently used as the source-control repository for the visual prototype. Forge itself is **not intended to be hosted through GitHub or Vercel** in the long term.

The intended future distinction is:

- GitHub: optional external source-control and collaboration connector during the transition
- Forge: standalone repository, build, validation, deployment, runtime, hosting, and AI operating environment

The future Forge platform may eventually host Git-compatible repositories inside Forge, with repository browsing, branches, commits, tags, pull requests, permissions, code review, builds, tests, artifacts, deployments, logs, events, and provenance. This is a later architecture phase, not current functionality.

## Future self-hosting model

A future Forge self-update loop should be controlled and reversible:

1. User or Forge states an intent.
2. Forge creates an isolated branch or worktree.
3. A Digital Person or agent proposes and implements changes.
4. Forge runs type checks, tests, security checks, policy checks, and visual validation.
5. Forge creates a preview or staging release.
6. The change is reviewed or approved according to its risk.
7. Forge deploys a versioned release.
8. Health checks and observability monitor the release.
9. Forge automatically rolls back if the release fails.

Forge must not blindly overwrite its only running instance. Future infrastructure should include immutable releases, staging and production separation, audit records, permission boundaries, approval gates, backups, and recovery versions.

## Expected future technical evolution

The current Forge prototype uses plain HTML, CSS, and browser JavaScript. It does not currently use Node.js, Next.js, Vercel, a backend, a database, or authentication.

That is a deliberate choice for the visual-only stage. The prototype can later be migrated into a full application architecture. A likely future web stack is Next.js 16 with React and Node.js 22 or newer, but this is an implementation decision for the application phase, not a requirement for the current static visual prototype. Next.js 15 remains possible if project compatibility or infrastructure makes it preferable; the version should be selected deliberately when backend work begins.

The future standalone Forge system may be split into a web interface, API, model gateway, agent runtime, Digital Person runtime, Work Graph service, build/test workers, deployment controller, event/provenance service, memory/knowledge service, database, object storage, and queue/event infrastructure.

## Working rule

Complete and refine Forge's supplied visual references first. Do not begin Digital Person architecture, repository hosting, self-training, external device connections, or autonomous self-deployment until the user explicitly asks to continue into those phases.
