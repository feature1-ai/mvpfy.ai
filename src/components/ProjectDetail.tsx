import { MvpfyState, Project } from '../../shared/types';
import { UpdateState, useProjectController } from '../hooks/useProjectController';
import { RunsApi } from '../lib/useRuns';
import LogPanel from './LogPanel';
import PreviewPane from './PreviewPane';
import EnvironmentCard from './project/EnvironmentCard';
import GeneratedFilesCard from './project/GeneratedFilesCard';
import ProjectHeader from './project/ProjectHeader';
import QuestionsCard from './project/QuestionsCard';
import StoriesCard from './project/StoriesCard';

interface Props {
  project: Project;
  state: MvpfyState;
  updateState: UpdateState;
  runsApi: RunsApi;
}

/** View composition for a project; all behavior lives in the controller hook. */
export default function ProjectDetail({ project, state, updateState, runsApi }: Props) {
  const c = useProjectController(project, state, updateState, runsApi);

  const overview = (
    <div className="flex flex-col gap-5 p-6">
      <ProjectHeader c={c} />
      {c.actionError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {c.actionError}
        </div>
      )}
      <EnvironmentCard c={c} />
      <QuestionsCard c={c} />
      <GeneratedFilesCard c={c} />
      <StoriesCard c={c} />
      <section>
        <LogPanel run={c.latestRun} onStop={c.stopRun} />
      </section>
    </div>
  );

  return (
    <PreviewPane
      appUrl={c.appUrl}
      appHealthy={c.appHealthy}
      ideUrl={c.ideUrl}
      ideHealthy={c.ideHealthy}
      ideStarting={c.ideStarting}
      busy={c.busy}
      onStartIde={() => void c.startIde()}
      onStopIde={() => void c.stopIde()}
      overview={overview}
    />
  );
}
