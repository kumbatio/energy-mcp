---
name: energy-autonomy-check
description: Check whether a run of unattended steps fits the energy level a person has set. Use before chaining several tool calls, edits or commands without stopping for them, before sending or publishing wording written on their behalf, when they hand over a task and step away, or when working as a background or scheduled agent.
---

# Checking before acting unattended

The lower a person's energy, the less they can supervise and undo what is done for them.
`check_autonomy_action` compares an action you plan to take with the limits for the level they
set, and says whether it fits.

## When to check

- Before a run of steps the person will not see one by one: a multi-file edit, a batch of
  commands, a chain of tool calls.
- Before sending, posting or publishing wording you composed for them.
- Again when the plan grows past what you checked, and again after a pause: the tool reads the
  level on every call, and the person may have changed it.

A single action the person has just asked for by name needs no check. They are attending to it.

## What to pass

- `confidence` (required, 0 to 1): your honest estimate that the action is what the person wants.
  An explicit instruction is high. A guess at what they meant is lower. Do not raise it to pass.
- `requiresGeneratedContent` (default `false`): `true` when the action sends or publishes wording
  you wrote, as opposed to a fixed template or text they already approved.
- `plannedSteps` (default 1): how many steps you will take before you next stop and hand back
  control. Count all of them.

The arguments are validated. A wrong type, a value out of range or an unknown argument name
returns an error that names the field. Correct the call; an error is not a pass.

## Reading the answer

The reply is JSON: `allowed`, the current `level`, the `autonomy` limits and `reasons`.

- `allowed: true`: go ahead, within what you declared.
- `allowed: false`: `reasons` names each limit the action exceeds.
  - Confidence below the threshold: ask the person to confirm before acting.
  - New wording where only fixed templates are allowed: show them the draft and let them send
    it, or use wording they have already approved.
  - More steps than the limit: do at most `autonomy.maxUnattendedSteps`, then stop, say what was
    done and ask before continuing.

Do not split or relabel an action to get under a limit. Five checks of one step each, run back to
back, are still a chain of five.

## The limits by level

| Level | Confidence needed | New wording | Steps before stopping |
| --- | --- | --- | --- |
| 100 Peak | 0.6 | allowed | 8 |
| 75 Active | 0.7 | allowed | 5 |
| 50 Steady | 0.8 | allowed | 3 |
| 25 Low | 0.9 | fixed templates only | 1 |
| 0 Rest | 1 | fixed templates only | 1 |

At Rest only certainty passes: an explicit instruction or a standing rule, one step at a time.

With no level stored, the check answers with the Peak limits, because the default level is 100.
Nobody chose those limits, so keep your usual care.

## What the check does not do

- It blocks nothing. It reads a file and returns an answer; acting on the answer is up to you.
- It widens nothing. `allowed: true` does not replace the person's instructions or the
  confirmations their Claude settings ask for.
