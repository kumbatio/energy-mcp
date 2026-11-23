---
name: energy-check-in
description: Record the energy level a person states. Use when they say what level they are at ("I'm at Low today", "set my energy to 50", "I'm in Rest"), ask to change or reset it, say the stored level is wrong, or describe how they feel and ask for it to be noted.
---

# Recording a level the person states

`set_energy_level` writes the level to the file the person's other apps read. A wrong level
changes more than this conversation, so the level recorded is only ever the one they stated.

## Only what they said

- Call `set_energy_level` only when the person states their level, by name or by number, in this
  conversation.
- The five levels: Peak is 100, Active is 75, Steady is 50, Low is 25, Rest is 0. No other number
  is a level. If they say "about 60", ask whether Steady or Active fits.
- Never infer a level: from how they write, the time of day, how long the session has run, or
  mistakes they make.
- If they describe how they feel without naming a level ("I'm wiped"), do not pick one for them.
  Name the five levels in one line and ask which fits. If they do not choose, leave the stored
  level as it is. You can still keep your own answer short.
- Do not propose a change of level on your own.

## How

1. Call `set_energy_level` with `level` as a number: 0, 25, 50, 75 or 100. A string such as
   `"25"` is refused.
2. The reply confirms the level and gives the guidance for it. Follow that guidance from your next
   sentence on.
3. Tell the person in one line that it is set. Do not paste the tool's reply.

`get_energy_guidance` shows the level currently stored, if you need it before or after.

## What gets recorded

- The level is stored with source `manual`, which marks it as the person's own declaration. When
  two apps write at the same moment, a manual level wins over one set by a schedule or inferred
  from behaviour. This is the reason it has to be their words.
- The file holds the current level only. There is no history and no undo. If you set the wrong
  level, say so and set the one they state.
- Setting the level that is already stored keeps the level and records it as stated now: the
  timestamp moves, and the source becomes `manual` if another app had set it.

## When it fails

- "Level must be one of the numbers 0, 25, 50, 75, or 100": correct the value.
- "The energy level was not changed: could not write ...": the file could not be written and the
  stored level is unchanged. Tell the person the path and the reason from the message. Do not
  retry more than once.
