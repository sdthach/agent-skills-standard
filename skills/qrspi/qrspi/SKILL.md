---
name: qrspi
description: "Orchestrator for the qrspi 8-phase delivery flow (Question → Research → Design → Structure → Plan → Worktree → Implement → PR). Use to route a ticket through neutral question decomposition, objective research, design, planning, and PR, with artifacts under thoughts/qrspi/<id>/."
metadata:
  triggers:
    keywords:
      - qrspi
      - qrspi flow
      - question research design plan
      - phased delivery
---

## **Priority: P1 (HIGH)**

## Overview

qrspi is a phased workflow that takes a task from ambiguous ticket to merged PR through 8 sequential phases. Each phase writes a durable artifact to the artifact directory (`thoughts/qrspi/<id>/`), and each phase is a workflow in its own right; some phases delegate to specialist sub-agents for codebase discovery, analysis, and research.

## Phases

1. `qrspi-1-question` — input: the task/ticket → output: `questions.md`
2. `qrspi-2-research` — input: `questions.md` → output: `research.md`
3. `qrspi-3-design` — input: `research.md` → output: `design.md`
4. `qrspi-4-structure` — input: `design.md` → output: `structure.md`
5. `qrspi-5-plan` — input: `structure.md` → output: `plan.md`
6. `qrspi-6-worktree` — create an isolated git worktree for the implementation phase
7. `qrspi-7-implement` — input: `plan.md` → phase-by-phase implementation, one commit per phase
8. `qrspi-8-pr` — input: `design.md` → open a PR (`gh pr create`)

## Sub-agents (specialists)

| Specialist | Purpose | Called by phases |
| :--- | :--- | :--- |
| `codebase-locator` | Find WHERE relevant code lives | 1-2 |
| `codebase-analyzer` | Understand HOW components work | 2-3 |
| `codebase-pattern-finder` | Find prior-art patterns/examples | 2-3 |
| `web-search-researcher` | Pull external/up-to-date info when local context is insufficient | as needed |

## Artifact flow

All phase artifacts accumulate in the same `thoughts/qrspi/<id>/` directory; each later phase reads the artifacts written by earlier phases, so that directory is the single source of truth handed from phase to phase.

## Routing

Start a qrspi run by invoking `qrspi-1-question` with the task or ticket. After each phase completes, follow that phase's own "Next:" pointer to advance to the following phase in the sequence above.
