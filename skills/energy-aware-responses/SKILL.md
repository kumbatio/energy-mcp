---
name: energy-aware-responses
description: Size answers, options and next steps to the energy level a person has set for themselves. Use at the start of a conversation or a piece of work, when they ask for a plan, a list of options, a review or what to do next, when they say they are tired, overloaded or short on focus, or when they ask what their energy level is.
---

# Sizing work to the person's energy level

The person sets an energy level for themselves: Peak (100), Active (75), Steady (50), Low (25) or
Rest (0). It is kept in one file on their computer and shared with every app that reads that file.
`get_energy_guidance` returns it, with what it means for the work in front of you.

## Read it first

- Call `get_energy_guidance` before the first substantial answer: before you plan, list options or
  propose next steps.
- Read it again before a new piece of work and after a long pause. The person can change the level
  at any time from their terminal or another app, and the tool reads the file on every call.
- Use the level; do not comment on it unless they ask.

## What comes back

The reply is JSON. These fields decide the shape of your answer:

- `guidance`: a short paragraph for the current level. Follow it.
- `choiceBudget.maxChoices`: the most options to put in front of the person at once. `null` means
  no limit. `0` means ask for no decision at all.
- `choiceBudget.responseDensity`: `detailed`, `balanced`, `concise`, `single-step` or `quiet`.
- `choiceBudget.allowProactiveSuggestions`: when `false`, leave out ideas they did not ask for.
- `taskComplexity.maxComplexity`: the hardest kind of work to propose, from `complex` down to
  `consumption` (reading only). `suggestBreaks` and `breakIntervalMinutes` say whether to mention
  a break and how often.
- `sensory.allowCallsToAction`: when `false`, end without a prompt to do something more.
- `autonomy`: limits on acting without the person watching. See the `energy-autonomy-check` skill.

| Level | Options at once | Density | Unasked suggestions | Hardest work to propose |
| --- | --- | --- | --- | --- |
| 100 Peak | no limit | detailed | yes | complex |
| 75 Active | up to 5 | balanced | yes | moderate |
| 50 Steady | up to 3 | concise | no | routine, a break every 45 minutes |
| 25 Low | 1 | single-step | no | simple, a break every 25 minutes |
| 0 Rest | none | quiet | no | reading only |

The tool's reply is the source. If it ever differs from this table, follow the reply.

## At Low and Rest

- **Low:** give one concrete next step, in few words. No menu. Ask before chaining actions.
- **Rest:** assign no work, push no decision, add no call to action. Summarise if asked, note
  things down quietly, and act only on an explicit, certain instruction.

The budget covers what you offer by default. When the person asks outright for the full list or
the long explanation, give them what they asked for.

## When no level has been set

Until someone sets a level, the tool returns the default: `state.level` 100, `state.timestamp` 0
and `state.origin` `"0-initial"`. Read that as "no level set". Work as you normally would, and do
not tell the person they are at Peak. If they ask what their level is, say none is set and that
they can tell you one (see the `energy-check-in` skill).

## Who set it, and when

- `state.source` is `manual` when the person set the level themselves. `scheduled` and `inferred`
  mean another app wrote it from a schedule or from behaviour.
- `state.timestamp` is when it was set, in milliseconds since 1970.

Follow the stored level either way. When the person tells you something different now, their
words come first: see `energy-check-in` for recording it.

## If the tool fails

Tell the person what it said and carry on without a level. Do not guess one.
