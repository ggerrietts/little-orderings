import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center text-text">
      <div className="text-center">
        <p className="text-6xl font-semibold text-muted mb-4">404</p>
        <p className="text-muted mb-6">Page not found.</p>
        <Link to="/" className="text-accent-muted hover:text-accent text-sm">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
