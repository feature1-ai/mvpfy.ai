import { QuestionsCard } from 'mvpfy';

const questions = [
  '1. The frontend calls an API at api.acme.internal — is the backend repo available,',
  '   or should I generate a mock service with sample data?',
  '2. STRIPE_SECRET_KEY is required at boot. OK to run with payments disabled locally?',
].join('\n');

const base = {
  questionsFile: { relativePath: 'mvpfy-questions.md', exists: true, content: questions },
  busy: false,
  answersDraft: '',
  setAnswersDraft: () => {},
  saveAnswersAndRerun: async () => {},
};

export const AwaitingAnswers = () => <QuestionsCard c={base as never} />;

export const AnswerDrafted = () => (
  <QuestionsCard
    c={
      {
        ...base,
        answersDraft:
          '1. Backend repo: https://github.com/acme/billing-api — clone it too\n2. Yes, disable payments locally',
      } as never
    }
  />
);
