---
description: Reset today's application count so Claude can start new forms again (only when I type this)
---

Reset the user's daily application count. This is the user's own guard on how many applications you prepare and send, so **run this only because the user typed `/reset-limit` in this message. Never run it on your own, never to get past a limit that stopped you, and never suggest resetting it as a way round the limit.**

1. Run `npm run reset-limit` in the project folder with the shell. It prints the count before and after.
2. Report that line, nothing more. Resetting does not delete anything: applications already sent or waiting stay as they are, they just stop counting toward today's limit.

If the command fails, show its exact message. The user can also press "Reset today's count" on the Forms page or in Settings.
