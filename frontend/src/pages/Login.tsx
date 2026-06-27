import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { setUser } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { user } = await auth.login(username, password);
      setUser(user);
      navigate('/');
    } catch {
      setError('Invalid username or password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-text mb-2">Little Orderings</h1>
        <p className="text-muted mb-8">Sign in to your account</p>

        <div className="bg-surface rounded-xl p-8 border border-border shadow-sm">
          {error && (
            <p className="text-danger text-sm mb-4 bg-danger-subtle rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text mb-1">
                Username
              </label>
              <input
                type="text"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-surface text-text rounded-lg px-3 py-2 text-sm
                           border border-border focus:outline-none focus:border-accent
                           placeholder:text-muted"
                placeholder="your-username"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text mb-1">
                Password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-surface text-text rounded-lg px-3 py-2 text-sm
                           border border-border focus:outline-none focus:border-accent"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-accent hover:bg-accent-hover disabled:opacity-50
                         text-surface font-semibold rounded-lg py-2 text-sm transition-colors"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
