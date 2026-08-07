import type { ProjectController } from '../../hooks/useProjectController';

export default function QuestionsCard({ c }: { c: ProjectController }) {
  if (!c.questionsFile || c.busy) return null;
  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-amber-700">
        The agent needs your input
      </h3>
      <pre className="mb-3 whitespace-pre-wrap rounded-md bg-white p-3 text-sm text-slate-800">
        {c.questionsFile.content}
      </pre>
      <textarea
        value={c.answersDraft}
        onChange={(e) => c.setAnswersDraft(e.target.value)}
        placeholder={
          'Answer the questions here, e.g.\n1. The backend repo is https://github.com/org/api\n2. Use any test key'
        }
        rows={4}
        className="mb-2 w-full rounded-md border border-amber-200 p-3 font-mono text-sm focus:border-amber-400 focus:outline-none"
      />
      <button
        onClick={() => void c.saveAnswersAndRerun()}
        disabled={!c.answersDraft.trim()}
        className="rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
      >
        Save answers & re-run bootstrap
      </button>
    </section>
  );
}
