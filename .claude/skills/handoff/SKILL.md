---
name: handoff
description: Checkpoint the current work so a new session on either Claude account can continue it. Use when the user is about to switch accounts, is running out of usage, pauses the work, or asks for a handoff.
---

# Hand off the current work

The next session, possibly in the user's other Claude account, sees only GitHub. Leave everything it needs there.

1. **Check.** Run the fast checks for what you changed (`pnpm --filter @aoc/<pkg> test` and `typecheck`). Note the
   command and the result.
2. **Commit and push** everything on the task branch. Subject `wip: …` if the checks are red; end the message with a
   `Next: <the very next concrete step>` trailer (the SessionStart status shows it). Then `git fetch origin <branch>`,
   `git merge origin/<branch>` if it moved, and `git push -u origin <branch>`. Never push to the default branch; never
   force-push.
3. **PR.** The branch needs a PR: open a draft if it has none (the user asking for a handoff is the request for one).
   Replace its `## Handoff` section, at most 15 lines:
   - **Done:** what is finished and verified.
   - **Next:** the very next step (file, function, test).
   - **Last check:** command, result, commit.
   - **Open decisions / gotchas:** what the next session must not have to rediscover.
4. If this session watches the PR's activity, unsubscribe: only one session receives a PR's events.
5. Reply with the line to paste into the other account: `/pickup <owner>/<repo>#<PR> (branch <branch>)`.
