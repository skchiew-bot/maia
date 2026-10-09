---
name: pickup
description: Continue work that another session handed off, on either Claude account. Use when the user says pick up, continue or resume a PR or branch, or has just switched accounts.
---

# Pick up handed-off work

1. **Find the task branch:** the PR or branch the user named; otherwise the SessionStart status's "Branches with work
   not in …" list. If more than one fits, ask which.
2. **Work on that branch, not a new one.** The user naming it is your permission to push to it:
   `git fetch origin <branch> && git checkout -B <branch> origin/<branch>`. If a push there is refused, continue on
   your own session branch created from that commit, open a PR that says it supersedes the old one, and tell the user.
3. **Read before changing anything:** the PR's `## Handoff` section, then
   `git log -5 --format='%h %s%n%(trailers:key=Next,valueonly)'`.
4. **Re-run the "Last check".** If it no longer passes, fixing that is the first step.
5. If the user wants the PR watched, subscribe to its activity (only one session receives its events).
6. Continue from **Next**, checkpointing as CLAUDE.md "Sessions and handoff" says.
