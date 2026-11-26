import { describe, expect, it } from 'vitest';
import { githubWith, projectFromFeature1, repositoriesIn } from './projectResolve';

// What Feature1's get_repository_context writes (mcp-server/project-metadata.js).
const CONTEXT = `# Repository Context: Jar share

## Connected Repositories (2)

### Jarshare
**URL**: https://github.com/Fastturtle-sa/Jarshare.git
**Status**: active
**Branch**: main

### Old
**URL**: https://github.com/Fastturtle-sa/Old.git
**Status**: archived
**Branch**: main


---

## Repository Health

- **Jarshare**: active
`;

const deps = (over: Partial<Parameters<typeof projectFromFeature1>[2]> = {}) => {
  const said: string[] = [];
  return {
    said,
    deps: {
      list: async () => repositoriesIn(CONTEXT),
      github: async () => ({ defaultBranch: 'master', canPush: true }),
      branchExists: async (_o: string, _r: string, branch: string) => branch === 'master',
      log: (line: string) => said.push(line),
      ...over,
    },
  };
};

describe("a build's repositories, from its project in Feature1", () => {
  it('reads the repositories Feature1 lists', () => {
    expect(repositoriesIn(CONTEXT)).toEqual([
      {
        name: 'Jarshare',
        url: 'https://github.com/Fastturtle-sa/Jarshare.git',
        branch: 'main',
        status: 'active',
      },
      {
        name: 'Old',
        url: 'https://github.com/Fastturtle-sa/Old.git',
        branch: 'main',
        status: 'archived',
      },
    ]);
  });

  it("builds the active ones, from GitHub's default when Feature1's branch is not there", async () => {
    const { deps: d, said } = deps();
    const project = await projectFromFeature1('p-1', 'JAR-US-335', d);
    expect(project.repositories).toHaveLength(1);
    expect(project.repositories[0]).toMatchObject({ name: 'Jarshare', base_branch: 'master' });
    expect(said.join('\n')).toContain(
      'Fastturtle-sa/Jarshare builds from main, which GitHub does not have'
    );
  });

  it("keeps Feature1's branch when it is there", async () => {
    const { deps: d, said } = deps({ branchExists: async () => true });
    const project = await projectFromFeature1('p-1', 'JAR-US-335', d);
    expect(project.repositories[0]?.base_branch).toBe('main');
    expect(said).toEqual([]);
  });

  it('refuses before anything is cloned, saying why', async () => {
    await expect(projectFromFeature1(null, 'JAR-T-4', deps().deps)).rejects.toThrow(
      /does not say which project JAR-T-4 belongs to/
    );
    await expect(
      projectFromFeature1('p-1', 'JAR-US-335', deps({ list: async () => [] }).deps)
    ).rejects.toThrow(/no repositories connected/);
    await expect(
      projectFromFeature1('p-1', 'JAR-US-335', deps({ github: async () => null }).deps)
    ).rejects.toThrow(/is not on GitHub for the runner's account/);
    await expect(
      projectFromFeature1(
        'p-1',
        'JAR-US-335',
        deps({ github: async () => ({ defaultBranch: 'master', canPush: false }) }).deps
      )
    ).rejects.toThrow(/not push to it/);
  });

  it("asks GitHub with the runner's token", async () => {
    const asked: Array<{ url: string; auth: string | undefined }> = [];
    const gh = githubWith('ghs_token', (async (url: string | URL, init?: RequestInit) => {
      asked.push({
        url: String(url),
        auth: (init?.headers as Record<string, string>).Authorization,
      });
      if (String(url).endsWith('/branches/main')) return new Response('{}', { status: 404 });
      return new Response(
        JSON.stringify({ default_branch: 'master', permissions: { push: true } })
      );
    }) as typeof fetch);
    expect(await gh.github('Fastturtle-sa', 'Jarshare')).toEqual({
      defaultBranch: 'master',
      canPush: true,
    });
    expect(await gh.branchExists('Fastturtle-sa', 'Jarshare', 'main')).toBe(false);
    expect(asked[0]).toEqual({
      url: 'https://api.github.com/repos/Fastturtle-sa/Jarshare',
      auth: 'Bearer ghs_token',
    });
  });
});
