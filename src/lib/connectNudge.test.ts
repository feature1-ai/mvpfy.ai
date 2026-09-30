import { describe, expect, it } from 'vitest';
import { Project } from '../../shared/types';
import {
  CONNECT_NUDGE_SNOOZE_MS,
  projectHasPlannedFeature,
  shouldShowConnectNudge,
} from './connectNudge';

const project = (patch: Partial<Project> = {}): Project => ({
  id: 'p1',
  repos: [],
  localPath: '/tmp/p1',
  basePort: 3000,
  status: 'running',
  lastStoryId: null,
  generatedFiles: [],
  ...patch,
});

const planned = project({ bootstrapAccepted: true, planSlugs: ['invoice-export'] });
const connected = { slug: 'acme', host: 'acme.feature1.ai', tokenKeychainEntry: 'mvpfy/acme' };

describe('projectHasPlannedFeature', () => {
  it('needs both an accepted setup and a planned feature', () => {
    expect(projectHasPlannedFeature(planned)).toBe(true);
    expect(projectHasPlannedFeature(project({ bootstrapAccepted: true }))).toBe(false);
    expect(projectHasPlannedFeature(project({ planSlugs: ['x'] }))).toBe(false);
  });
});

describe('shouldShowConnectNudge', () => {
  it('shows once a set-up project has a planned feature and Feature1 is not connected', () => {
    expect(shouldShowConnectNudge({ tenant: null, projects: [planned] }, null)).toBe(true);
  });

  it('stays quiet before anything is planned, and on the setup screens', () => {
    expect(shouldShowConnectNudge({ tenant: null, projects: [] }, null)).toBe(false);
    expect(
      shouldShowConnectNudge(
        { tenant: null, projects: [project({ bootstrapAccepted: true })] },
        null
      )
    ).toBe(false);
  });

  it('never shows once connected', () => {
    expect(shouldShowConnectNudge({ tenant: connected, projects: [planned] }, null)).toBe(false);
  });

  it('honours "Not now" for the snooze window, then returns', () => {
    const dismissed = new Date('2026-09-01T00:00:00Z');
    const soon = new Date(dismissed.getTime() + CONNECT_NUDGE_SNOOZE_MS - 1000);
    const later = new Date(dismissed.getTime() + CONNECT_NUDGE_SNOOZE_MS);
    const state = { tenant: null, projects: [planned] };
    expect(shouldShowConnectNudge(state, dismissed.toISOString(), soon)).toBe(false);
    expect(shouldShowConnectNudge(state, dismissed.toISOString(), later)).toBe(true);
    expect(shouldShowConnectNudge(state, 'not-a-date', soon)).toBe(true);
  });
});
