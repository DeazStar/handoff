import { getSyncTargets, ingestMessages, purgeOldSnippets, recordSync, scanFollowUps, type DB, type IngestResult } from "@jobhunt/core";
import type { ImapReader } from "./imap.js";

export interface ReplySync {
  /** Checks the mailbox once. Only one check runs at a time. */
  run(): Promise<IngestResult & { skipped?: string }>;
  isRunning(): boolean;
}

/**
 * Reads the mailbox through `reader`, keeps what belongs to an application, and updates reminders. With nothing sent yet there is
 * nothing to look for, so the mailbox is not even opened. Failures are recorded so the Replies page can show the reason.
 */
export function createReplySync(db: DB, reader: ImapReader): ReplySync {
  let running = false;
  return {
    isRunning: () => running,
    async run() {
      if (running) throw new Error("A check is already running");
      running = true;
      try {
        const targets = getSyncTargets(db);
        if (targets.messageIds.length === 0 && targets.senders.length === 0) {
          recordSync(db, { checked: 0, matched: 0 });
          scanFollowUps(db, "system");
          return { checked: 0, matched: 0, replies: 0, bounces: 0, movedToReplied: 0, skipped: "No email has been sent and no email application recorded yet, so there is nothing to look for." };
        }
        let messages;
        try {
          messages = await reader.fetch(targets);
        } catch (e) {
          recordSync(db, { error: e instanceof Error ? e.message : "Checking the mailbox failed" });
          throw e;
        }
        const result = ingestMessages(db, messages, "system");
        purgeOldSnippets(db);
        scanFollowUps(db, "system");
        recordSync(db, { checked: result.checked, matched: result.matched });
        return result;
      } finally {
        running = false;
      }
    },
  };
}
