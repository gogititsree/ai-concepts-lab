import { Route, Routes } from 'react-router';

import { HomePage } from './routes/HomePage';

// Declarative mode (React Router 7). A data router can come later if a route actually
// needs a loader; M1 has a single page.
export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="*" element={<p className="p-6">Not found</p>} />
    </Routes>
  );
}
