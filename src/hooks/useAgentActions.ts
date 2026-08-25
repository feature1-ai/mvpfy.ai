import { useState } from 'react';
import { CHANGE_FILE } from '../../shared/types';
import { startInstructRun, startShipChangeRun, startShipFeatureRun } from '../lib/agentRunner';
import { preflightAuth } from '../lib/cliCheck';
import { Feature1McpClient, UserStory } from '../lib/feature1Mcp';
import { ControllerContext } from './controllerContext';

/** Agent-driven changes: instructions, shipping, and Feature1 stories. */
export interface AgentActions {
  /** Free-form PM instruction ("add env var X…") applied by the agent. */
  instruct(instruction: string): Promise<boolean>;
  dismissChange(): Promise<boolean>;
  /** Commit + push the workspace's product changes and open PR(s). */
  shipChange(): Promise<boolean>;
  refreshStories(): Promise<boolean>;
  implement(story: UserStory): Promise<boolean>;
  stories: UserStory[];
  storiesError: string | null;
  loadingStories: boolean;
  targetRepoDir: string;
  setTargetRepoDir(dir: string): void;
}

export function useAgentActions(ctx: ControllerContext): AgentActions {
  const { project, state, runsApi, pf, refreshFiles, guarded } = ctx;
  const [stories, setStories] = useState<UserStory[]>([]);
  const [storiesError, setStoriesError] = useState<string | null>(null);
  const [loadingStories, setLoadingStories] = useState(false);
  const [targetRepoDir, setTargetRepoDir] = useState(project.repos[0]?.dir ?? project.localPath);

  const instruct = (instruction: string) =>
    guarded(async () => {
      const text = instruction.trim();
      if (!text) return;
      const authProblem = await preflightAuth(state.settings.defaultAgent, false);
      if (authProblem) throw new Error(authProblem);
      await window.mvpfy.writeRepoFile(project.localPath, pf(CHANGE_FILE), '');
      const handle = await startInstructRun(project, state.settings, text);
      runsApi.track(handle);
    });

  const dismissChange = () =>
    guarded(async () => {
      await window.mvpfy.writeRepoFile(project.localPath, pf(CHANGE_FILE), '');
      refreshFiles();
    });

  const shipChange = () =>
    guarded(async () => {
      // Shipping needs the agent AND gh (push + PR creation) signed in.
      const authProblem = await preflightAuth(state.settings.defaultAgent, true);
      if (authProblem) throw new Error(authProblem);
      const handle = await startShipChangeRun(project, state.settings);
      runsApi.track(handle);
    });

  const refreshStories = () =>
    guarded(async () => {
      if (!state.tenant) {
        setStoriesError('Connect Feature1 in Settings first.');
        return;
      }
      setLoadingStories(true);
      setStoriesError(null);
      try {
        const token = await window.mvpfy.keychainGet(state.tenant.tokenKeychainEntry);
        const client = new Feature1McpClient(state.tenant.slug, token);
        setStories(await client.listUserStories());
      } catch (err) {
        setStoriesError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingStories(false);
      }
    });

  const implement = (story: UserStory) =>
    guarded(async () => {
      // Ship needs the agent AND gh (push + PR creation) to be signed in.
      const authProblem = await preflightAuth(state.settings.defaultAgent, true);
      if (authProblem) throw new Error(authProblem);
      const handle = await startShipFeatureRun(project, story.id, state.settings, targetRepoDir);
      runsApi.track(handle);
    });

  return {
    instruct,
    dismissChange,
    shipChange,
    refreshStories,
    implement,
    stories,
    storiesError,
    loadingStories,
    targetRepoDir,
    setTargetRepoDir,
  };
}
