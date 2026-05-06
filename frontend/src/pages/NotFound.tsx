import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">
      <div className="text-center">
        <p className="text-6xl font-bold text-slate-700 mb-4">404</p>
        <p className="text-slate-400 mb-6">Page not found.</p>
        <Link to="/" className="text-emerald-500 hover:text-emerald-400 text-sm">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
