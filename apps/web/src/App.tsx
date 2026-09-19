import { Route, Routes } from 'react-router';

import { AppShell } from './components/AppShell';
import { RequireAnonymous, RequireAuth } from './features/auth/RequireAuth';
import { ExercisePage } from './routes/ExercisePage';
import { HomePage } from './routes/HomePage';
import { LessonPage } from './routes/LessonPage';
import { ModuleOverviewPage } from './routes/ModuleOverviewPage';
import { ModulesPage } from './routes/ModulesPage';
import { NotFound } from './routes/NotFound';
import { QuizPage } from './routes/QuizPage';
import { LoginPage } from './routes/auth/LoginPage';
import { MfaPage } from './routes/auth/MfaPage';
import { RegisterPage } from './routes/auth/RegisterPage';
import { RunDetailPage } from './routes/runs/RunDetailPage';
import { RunsPage } from './routes/runs/RunsPage';
import { SecuritySettingsPage } from './routes/auth/SecuritySettingsPage';

/**
 * Declarative mode (React Router 7), per docs/01-architecture.md.
 *
 * This route table is the frozen shape later milestones fill in: M6 replaces the four
 * placeholder screens under `routes/auth/`, M7 switches the module pages from the bundled
 * content to API queries, and M10/M11 add `/runs`. Keeping the table here means those
 * milestones touch leaf files only.
 *
 * Reading lessons does not require an account; anything that writes progress to the server
 * does, so the module pages sit behind `RequireAuth` from M7 onwards. Until then they read
 * bundled content and localStorage, so they stay open.
 */
export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<HomePage />} />

        <Route
          path="/login"
          element={
            <RequireAnonymous>
              <LoginPage />
            </RequireAnonymous>
          }
        />
        <Route
          path="/register"
          element={
            <RequireAnonymous>
              <RegisterPage />
            </RequireAnonymous>
          }
        />
        {/* The MFA screen is reachable only with a pending session, which it checks itself. */}
        <Route path="/login/mfa" element={<MfaPage />} />
        <Route
          path="/settings/security"
          element={
            <RequireAuth>
              <SecuritySettingsPage />
            </RequireAuth>
          }
        />

        {/* M10 fills these in; the trace viewer is shared by modules 5 and 6 and the SRE lesson. */}
        <Route
          path="/runs"
          element={
            <RequireAuth>
              <RunsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/runs/:id"
          element={
            <RequireAuth>
              <RunDetailPage />
            </RequireAuth>
          }
        />

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
