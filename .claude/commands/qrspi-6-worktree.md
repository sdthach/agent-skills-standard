# Qrspi 6 Worktree

qrspi phase 6/8: create an isolated git worktree for implementation. Run after qrspi-5-plan. Next: qrspi-7-implement.

**Input:** $ARGUMENTS

Optional args: slug=<feature>, ticket=<id/url>, mode=interactive|autonomous|channel, channel=<id>, auto_continue=true|false, profile=business|hybrid|technical.

## Instructions

Execute the following steps for **$ARGUMENTS**.


# Worktree — Isolate the Implementation

Create a git worktree so implementation happens on an isolated branch without affecting your main working tree.

## Input

The user provides the artifact directory (e.g. `thoughts/qrspi/<id>/`).

## Process

1. **Determine identifiers** from the artifact directory name:
   - Branch name: derive from the directory name (e.g., `ENG-1234-description` or `2026-03-29-new-feature`)
   - Repo name: detect from `basename $(git rev-parse --show-toplevel)`
   - Worktree path: `~/wt/<repo-name>/<branch-name>`

2. **Create the worktree:**
   ```
   git worktree add ~/wt/<repo-name>/<branch-name> -b <branch-name>
   ```

3. **Confirm with the user** before executing:
   ```
   Ready to create worktree:

   Worktree: ~/wt/<repo-name>/<branch-name>
   Branch: <branch-name>
   Plan: the `plan.md` file in the artifact directory

   To implement, run from the worktree the **qrspi-7-implement** workflow.

   Proceed?
   ```

4. **Create the worktree** after user confirms.

5. **Copy QRSPI artifacts** to the worktree. Untracked files from the main tree do not appear in worktrees:
   ```
   cp -r <artifact-directory> ~/wt/<repo-name>/<branch-name>/<artifact-directory>
   ```

## Output

- Git worktree created at `~/wt/<repo-name>/<branch-name>`
- QRSPI artifacts copied to the worktree
- Tell the user the worktree path and how to start implementation

## Rules

- Always confirm before creating the worktree.
- Worktrees do not share untracked files with the main tree. Always copy the artifact directory after creating the worktree.
- Do not start implementation. That's a separate phase with a separate context window.

## When to Go Back

If the plan doesn't exist yet at the `plan.md` file in the artifact directory, tell the user to run the **qrspi-5-plan** workflow first.
