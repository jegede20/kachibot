/**
 * KACHIBOT — notification channel. The bot core registers a sender; trader &
 * watcher push events without importing telegraf.
 */
export type NotifyOpts = {
  /** inline keyboard rows: [ [label, callbackData], ... ] per row */
  buttons?: Array<Array<[string, string]>>;
  silent?: boolean;
  replyToMsgId?: number;
};

type Sender = (userId: number, html: string, opts?: NotifyOpts) => Promise<void>;

let sender: Sender | null = null;

export function registerNotifier(fn: Sender): void {
  sender = fn;
}

export function hasNotifier(): boolean {
  return sender !== null;
}

export async function notifyUser(userId: number, html: string, opts?: NotifyOpts): Promise<boolean> {
  if (!sender) return false;
  try {
    await sender(userId, html, opts);
    return true;
  } catch (e) {
    console.error(`[notify] failed for user ${userId}:`, (e as Error).message);
    return false;
  }
}
