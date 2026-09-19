import { Route, Routes } from 'react-router';

import { AppShell } from './components/AppShell';
import { ExercisePage } from './routes/ExercisePage';
import { HomePage } from './routes/HomePage';
import { LessonPage } from './routes/LessonPage';
import { ModuleOverviewPage } from './routes/ModuleOverviewPage';
import { ModulesPage } from './routes/ModulesPage';
import { NotFound } from './routes/NotFound';
import { QuizPage } from './routes/QuizPage';

/**
 * Declarative mode (React Router 7), per docs/01-architecture.md. No data router yet: every
 * route's content is already in the bundle (`src/content/static.ts`), so there is nothing for a
 * loader to load. M7 introduces TanStack Query, and the route table below does not change.
 */
export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/modules" element={<ModulesPage />} />
        <Route path="/modules/:slug" element={<ModuleOverviewPage />} />
        <Route path="/modules/:slug/lessons/:lessonSlug" element={<LessonPage />} />
        <Route path="/modules/:slug/exercise" element={<ExercisePage />} />
        <Route path="/modules/:slug/quiz" element={<QuizPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
