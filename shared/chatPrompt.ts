/**
 * What a coding agent is told in a conversation about the running product.
 *
 * Shared by the desktop's App tab (src/lib/agentRunner.ts) and the hosted
 * chat beside a test link (worker/chat.ts), so the rules that keep a
 * product manager's app working are written once.
 */

/** What every change must leave true, whatever else it does. */
export const WORKSPACE_CONTRACT =
  'THINGS THE APP DEPENDS ON — whatever else you change, leave these true:\n' +
  "• mvpfy.yml is how mvpfy finds and describes the running product. The main app's " +
  '`host_port` and the port inside its `url` must be identical to each other AND to the port ' +
  'docker-compose.mvpfy.yml actually publishes. If your change moves that port, change ' +
  "mvpfy.yml in the same edit — otherwise the product manager's app points at nothing and " +
  'their product looks like it never started.\n' +
  '• The `demo_login:` and `demo_credentials:` blocks in mvpfy.yml are how the product ' +
  'manager gets into their own product, and the app shows them those values. They must be ' +
  'credentials that actually work. If your change alters how anyone signs in — a rebuilt ' +
  'database, a new secret, a changed auth setting — re-seed that account and update the ' +
  'block. If you deliberately remove a demo account, remove the block too rather than leave ' +
  'a login on screen that no longer opens anything.\n' +
  '• Seeded demo data is what they test against. Never drop a database volume or delete ' +
  'seeded rows to make something work; if a schema genuinely has to be rebuilt, re-seed it ' +
  'afterwards.';

/** Continuing a conversation: which instructions are live now. */
export const RESUME_NOTE =
  'NOTE — this continues our earlier conversation about this workspace, so you already know ' +
  'the code and the decisions behind it; use that rather than reading everything again. The ' +
  'instructions below REPLACE the ones from that earlier step: where they differ, these win, ' +
  'and any restriction you were under before no longer applies unless it is repeated here. ' +
  'The files on disk may have changed since — check anything you are about to rely on rather ' +
  'than trusting what you remember of it.';

/** The hosted chat's prompt: src/prompts/app-chat-hosted.txt, filled in. */
export function hostedChatPrompt(
  template: string,
  fields: {
    repoPath: string;
    resume: boolean;
    workTitle: string;
    guidance?: string;
    message: string;
  }
): string {
  const values: Record<string, string> = {
    repoPath: fields.repoPath,
    resumeNote: fields.resume ? RESUME_NOTE : '',
    workTitle: fields.workTitle,
    guidanceNote: fields.guidance?.trim()
      ? `The team's design principles and architecture — follow them:\n${fields.guidance.trim()}`
      : '',
    contractNote: WORKSPACE_CONTRACT,
    message: fields.message,
  };
  // One pass, so a placeholder inside what they typed is left as typed.
  return template.replace(
    /\{(repoPath|resumeNote|workTitle|guidanceNote|contractNote|message)\}/g,
    (_, key: string) => values[key] ?? ''
  );
}
