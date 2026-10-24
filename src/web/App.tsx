import { useEffect, useState } from 'react';
import { api } from './api';

interface Session {
  label: string;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Session>('/api/session').then(setSession, (err: Error) => setError(err.message));
  }, []);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">review-dash</h1>
      {error && <p className="mt-4 text-red-600">Failed to load session: {error}</p>}
      {session && (
        <p className="mt-4 text-gray-700">
          Reviewing <code className="rounded bg-gray-100 px-1.5 py-0.5">{session.label}</code>
        </p>
      )}
    </main>
  );
}
